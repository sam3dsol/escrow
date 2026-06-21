/**
 * Escrow client demo.
 *
 * Drives the deployed escrow program end to end through the SDK: it creates two
 * SPL mints, funds a maker and a taker, opens an escrow, fills it, then opens a
 * second escrow and refunds it, printing balances at each step. Run against a
 * local validator (default) or any cluster via ANCHOR_PROVIDER_URL.
 */
import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
  PublicKey,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import idl from "../target/idl/escrow.json";
import { Escrow } from "../target/types/escrow";
import { EscrowClient } from "../sdk";

const DECIMALS = 6;
const unit = 10 ** DECIMALS;
const URL = process.env.ANCHOR_PROVIDER_URL || "http://127.0.0.1:8899";

const log = (s: string) => console.log(s);
const tokens = (n: bigint | number) => (Number(n) / unit).toLocaleString();

async function airdrop(connection: Connection, to: PublicKey, sol: number) {
  const sig = await connection.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(sig, "confirmed");
}

async function send(
  connection: Connection,
  ix: TransactionInstruction,
  signers: Keypair[]
): Promise<string> {
  const tx = new Transaction().add(ix);
  tx.feePayer = signers[0].publicKey;
  return sendAndConfirmTransaction(connection, tx, signers, { commitment: "confirmed" });
}

async function balance(connection: Connection, ata: PublicKey): Promise<string> {
  try {
    const acc = await getAccount(connection, ata, "confirmed", TOKEN_PROGRAM_ID);
    return tokens(acc.amount);
  } catch {
    return "0";
  }
}

async function main() {
  const connection = new Connection(URL, "confirmed");
  const payer = Keypair.generate();
  const wallet = new anchor.Wallet(payer);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  const program = new anchor.Program(idl as Escrow, provider);
  const client = new EscrowClient(program);

  log("Escrow demo on " + URL + "\n");

  const maker = Keypair.generate();
  const taker = Keypair.generate();
  for (const kp of [payer, maker, taker]) await airdrop(connection, kp.publicKey, 5);

  log("Creating two SPL tokens (A and B) and funding the maker and taker...");
  const mintA = await createMint(connection, maker, maker.publicKey, null, DECIMALS);
  const mintB = await createMint(connection, taker, taker.publicKey, null, DECIMALS);
  const makerAtaA = (await getOrCreateAssociatedTokenAccount(connection, maker, mintA, maker.publicKey)).address;
  const takerAtaB = (await getOrCreateAssociatedTokenAccount(connection, taker, mintB, taker.publicKey)).address;
  await mintTo(connection, maker, mintA, makerAtaA, maker, BigInt(1000 * unit));
  await mintTo(connection, taker, mintB, takerAtaB, taker, BigInt(1000 * unit));
  log("  maker holds 1,000 token A, taker holds 1,000 token B\n");

  // ---- make + take ----
  const deposit = new BN(100 * unit);
  const receive = new BN(250 * unit);
  const seed1 = new BN(1);

  log("1. Maker opens an escrow: lock 100 A, ask for 250 B");
  await send(connection, await client.makeIx({ maker: maker.publicKey, mintA, mintB, seed: seed1, deposit, receive }), [maker]);
  log("   vault now holds " + (await balance(connection, client.vault(maker.publicKey, seed1, mintA))) + " token A\n");

  log("2. Taker fills the escrow (atomic swap)");
  await send(connection, await client.takeIx({ taker: taker.publicKey, maker: maker.publicKey, mintA, mintB, seed: seed1 }), [taker]);

  const takerAtaA = anchor.utils.token.associatedAddress({ mint: mintA, owner: taker.publicKey });
  const makerAtaB = anchor.utils.token.associatedAddress({ mint: mintB, owner: maker.publicKey });
  log("   taker received " + (await balance(connection, takerAtaA)) + " token A");
  log("   maker received " + (await balance(connection, makerAtaB)) + " token B");
  const closed = await program.account.escrow.fetchNullable(client.escrow(maker.publicKey, seed1));
  log("   escrow closed: " + (closed === null) + "\n");

  // ---- make + refund ----
  const seed2 = new BN(2);
  log("3. Maker opens a second escrow, then changes their mind");
  await send(connection, await client.makeIx({ maker: maker.publicKey, mintA, mintB, seed: seed2, deposit, receive }), [maker]);
  const beforeRefund = await balance(connection, makerAtaA);
  log("   locked 100 A again, maker A balance: " + beforeRefund);
  await send(connection, await client.refundIx({ maker: maker.publicKey, mintA, seed: seed2 }), [maker]);
  log("   after refund, maker A balance: " + (await balance(connection, makerAtaA)) + " (made whole)\n");

  log("Done. make, take, and refund all worked through the SDK.");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  }
);
