import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Escrow } from "../target/types/escrow";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAssociatedTokenAddressSync,
  getAccount,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { assert } from "chai";

describe("escrow", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Escrow as Program<Escrow>;
  const connection = provider.connection;

  const maker = Keypair.generate();
  const taker = Keypair.generate();

  const DECIMALS = 6;
  const unit = 10 ** DECIMALS;
  const DEPOSIT = new BN(100 * unit); // maker locks 100 of token A
  const RECEIVE = new BN(250 * unit); // maker wants 250 of token B

  let mintA: PublicKey;
  let mintB: PublicKey;
  let makerAtaA: PublicKey;
  let takerAtaB: PublicKey;

  const escrowPda = (seed: BN) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), maker.publicKey.toBuffer(), seed.toArrayLike(Buffer, "le", 8)],
      program.programId
    )[0];

  const ata = (mint: PublicKey, owner: PublicKey, offCurve = false) =>
    getAssociatedTokenAddressSync(mint, owner, offCurve, TOKEN_PROGRAM_ID);

  const makeAccounts = (seed: BN) => {
    const escrow = escrowPda(seed);
    return {
      maker: maker.publicKey,
      mintA,
      mintB,
      makerAtaA,
      escrow,
      vault: ata(mintA, escrow, true),
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    };
  };

  before(async () => {
    for (const kp of [maker, taker]) {
      const sig = await connection.requestAirdrop(kp.publicKey, 10 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, "confirmed");
    }
    mintA = await createMint(connection, maker, maker.publicKey, null, DECIMALS);
    mintB = await createMint(connection, taker, taker.publicKey, null, DECIMALS);

    makerAtaA = (await getOrCreateAssociatedTokenAccount(connection, maker, mintA, maker.publicKey)).address;
    takerAtaB = (await getOrCreateAssociatedTokenAccount(connection, taker, mintB, taker.publicKey)).address;

    await mintTo(connection, maker, mintA, makerAtaA, maker, BigInt(1000 * unit));
    await mintTo(connection, taker, mintB, takerAtaB, taker, BigInt(1000 * unit));
  });

  it("make: maker locks token A and opens the escrow", async () => {
    const seed = new BN(1);
    const accts = makeAccounts(seed);

    await program.methods
      .make(seed, DEPOSIT, RECEIVE)
      .accountsPartial(accts)
      .signers([maker])
      .rpc();

    const vault = await getAccount(connection, accts.vault, undefined, TOKEN_PROGRAM_ID);
    assert.equal(vault.amount.toString(), DEPOSIT.toString(), "vault holds the deposit");

    const escrow = await program.account.escrow.fetch(accts.escrow);
    assert.ok(escrow.maker.equals(maker.publicKey));
    assert.ok(escrow.mintA.equals(mintA));
    assert.ok(escrow.mintB.equals(mintB));
    assert.equal(escrow.receive.toString(), RECEIVE.toString());
  });

  it("take: taker fills the escrow atomically", async () => {
    const seed = new BN(1);
    const escrow = escrowPda(seed);
    const takerAtaA = ata(mintA, taker.publicKey);
    const makerAtaB = ata(mintB, maker.publicKey);

    await program.methods
      .take()
      .accountsPartial({
        taker: taker.publicKey,
        maker: maker.publicKey,
        mintA,
        mintB,
        takerAtaA,
        takerAtaB,
        makerAtaB,
        escrow,
        vault: ata(mintA, escrow, true),
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([taker])
      .rpc();

    const gotA = await getAccount(connection, takerAtaA, undefined, TOKEN_PROGRAM_ID);
    assert.equal(gotA.amount.toString(), DEPOSIT.toString(), "taker received token A");

    const gotB = await getAccount(connection, makerAtaB, undefined, TOKEN_PROGRAM_ID);
    assert.equal(gotB.amount.toString(), RECEIVE.toString(), "maker received token B");

    assert.isNull(await program.account.escrow.fetchNullable(escrow), "escrow closed");
    assert.isNull(await connection.getAccountInfo(ata(mintA, escrow, true)), "vault closed");
  });

  it("refund: maker cancels and reclaims token A", async () => {
    const seed = new BN(2);
    const accts = makeAccounts(seed);

    const before = await getAccount(connection, makerAtaA, undefined, TOKEN_PROGRAM_ID);
    await program.methods.make(seed, DEPOSIT, RECEIVE).accountsPartial(accts).signers([maker]).rpc();
    await program.methods
      .refund()
      .accountsPartial({
        maker: maker.publicKey,
        mintA,
        makerAtaA,
        escrow: accts.escrow,
        vault: accts.vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([maker])
      .rpc();

    const after = await getAccount(connection, makerAtaA, undefined, TOKEN_PROGRAM_ID);
    assert.equal(after.amount.toString(), before.amount.toString(), "maker is made whole");
    assert.isNull(await program.account.escrow.fetchNullable(accts.escrow), "escrow closed");
  });

  it("make: rejects a zero deposit", async () => {
    const seed = new BN(3);
    try {
      await program.methods.make(seed, new BN(0), RECEIVE).accountsPartial(makeAccounts(seed)).signers([maker]).rpc();
      assert.fail("expected the call to revert");
    } catch (e) {
      assert.include(e.toString(), "InvalidAmount");
    }
  });

  it("make: rejects the same mint for A and B", async () => {
    const seed = new BN(4);
    const escrow = escrowPda(seed);
    try {
      await program.methods
        .make(seed, DEPOSIT, RECEIVE)
        .accountsPartial({
          maker: maker.publicKey,
          mintA,
          mintB: mintA,
          makerAtaA,
          escrow,
          vault: ata(mintA, escrow, true),
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([maker])
        .rpc();
      assert.fail("expected the call to revert");
    } catch (e) {
      assert.include(e.toString(), "SameMint");
    }
  });
});
