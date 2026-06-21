/**
 * Escrow SDK
 *
 * A thin, typed client over the escrow program: PDA helpers plus instruction
 * builders for make, take, and refund. Build instructions and drop them into
 * your own transaction, or send them directly through the Anchor program.
 */
import { Program, BN, web3 } from "@coral-xyz/anchor";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Escrow } from "../target/types/escrow";

export const ESCROW_SEED = Buffer.from("escrow");

/** Derive the escrow state PDA for a maker and a numeric seed. */
export function findEscrow(
  programId: PublicKey,
  maker: PublicKey,
  seed: BN
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [ESCROW_SEED, maker.toBuffer(), seed.toArrayLike(Buffer, "le", 8)],
    programId
  );
}

/** The vault is the escrow PDA's associated token account for mint A. */
export function vaultAddress(
  mintA: PublicKey,
  escrow: PublicKey,
  tokenProgram: PublicKey = TOKEN_PROGRAM_ID
): PublicKey {
  return getAssociatedTokenAddressSync(mintA, escrow, true, tokenProgram);
}

export interface MakeParams {
  maker: PublicKey;
  mintA: PublicKey;
  mintB: PublicKey;
  seed: BN;
  deposit: BN; // base units of mint A to lock
  receive: BN; // base units of mint B requested
}

export interface TakeParams {
  taker: PublicKey;
  maker: PublicKey;
  mintA: PublicKey;
  mintB: PublicKey;
  seed: BN;
}

export interface RefundParams {
  maker: PublicKey;
  mintA: PublicKey;
  seed: BN;
}

export class EscrowClient {
  constructor(
    public readonly program: Program<Escrow>,
    public readonly tokenProgram: PublicKey = TOKEN_PROGRAM_ID
  ) {}

  escrow(maker: PublicKey, seed: BN): PublicKey {
    return findEscrow(this.program.programId, maker, seed)[0];
  }

  vault(maker: PublicKey, seed: BN, mintA: PublicKey): PublicKey {
    return vaultAddress(mintA, this.escrow(maker, seed), this.tokenProgram);
  }

  private ata(mint: PublicKey, owner: PublicKey, offCurve = false): PublicKey {
    return getAssociatedTokenAddressSync(mint, owner, offCurve, this.tokenProgram);
  }

  async makeIx(p: MakeParams): Promise<TransactionInstruction> {
    const escrow = this.escrow(p.maker, p.seed);
    return this.program.methods
      .make(p.seed, p.deposit, p.receive)
      .accountsPartial({
        maker: p.maker,
        mintA: p.mintA,
        mintB: p.mintB,
        makerAtaA: this.ata(p.mintA, p.maker),
        escrow,
        vault: vaultAddress(p.mintA, escrow, this.tokenProgram),
        tokenProgram: this.tokenProgram,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
      })
      .instruction();
  }

  async takeIx(p: TakeParams): Promise<TransactionInstruction> {
    const escrow = this.escrow(p.maker, p.seed);
    return this.program.methods
      .take()
      .accountsPartial({
        taker: p.taker,
        maker: p.maker,
        mintA: p.mintA,
        mintB: p.mintB,
        takerAtaA: this.ata(p.mintA, p.taker),
        takerAtaB: this.ata(p.mintB, p.taker),
        makerAtaB: this.ata(p.mintB, p.maker),
        escrow,
        vault: vaultAddress(p.mintA, escrow, this.tokenProgram),
        tokenProgram: this.tokenProgram,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
      })
      .instruction();
  }

  async refundIx(p: RefundParams): Promise<TransactionInstruction> {
    const escrow = this.escrow(p.maker, p.seed);
    return this.program.methods
      .refund()
      .accountsPartial({
        maker: p.maker,
        mintA: p.mintA,
        makerAtaA: this.ata(p.mintA, p.maker),
        escrow,
        vault: vaultAddress(p.mintA, escrow, this.tokenProgram),
        tokenProgram: this.tokenProgram,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
      })
      .instruction();
  }
}
