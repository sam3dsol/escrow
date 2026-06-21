# Escrow

A trustless SPL token escrow for atomic over the counter swaps on Solana, written in Anchor. A maker locks token A in a program owned vault and names the amount of token B they want. A taker fills the deal in one atomic transaction: they pay token B to the maker and receive token A from the vault. The maker can refund and reclaim token A any time before the deal is taken. Works with both SPL Token and Token 2022 through the token interface.

## Why this exists

No middleman holds the funds. The vault is owned by a Program Derived Address, so only the program logic can move the tokens, and either the deal completes exactly as specified or nothing moves. This is the canonical building block behind OTC desks, peer to peer swaps, and "I will trade X for Y" flows.

## Instructions

| Instruction | Who | Effect |
|---|---|---|
| `make(seed, deposit, receive)` | maker | Creates the escrow state and vault, moves `deposit` of mint A into the vault, records that the maker wants `receive` of mint B. |
| `take()` | taker | Sends `receive` of mint B straight to the maker, releases the vaulted mint A to the taker, closes the vault and escrow, returns rent to the maker. |
| `refund()` | maker | Returns the vaulted mint A to the maker, closes the vault and escrow. |

## Accounts and PDAs

- Escrow state PDA: seeds `["escrow", maker, seed]`. Stores maker, mint A, mint B, the requested receive amount, and the bump.
- Vault: the escrow PDA's associated token account for mint A. The PDA signs its own transfers and close.

## Security model

- `has_one` checks bind the stored maker, mint A, and mint B to the accounts passed at take and refund, so a caller cannot swap in a different mint or maker.
- The vault authority is the escrow PDA, so funds can only move through `take` or `refund`.
- `make` rejects a zero deposit, a zero receive, and the same mint for A and B.
- Atomic settlement: the taker's payment and the maker's release happen in one transaction, so there is no half filled state.

## Build, test, deploy

```bash
# build the program and generate the IDL and TypeScript types
anchor build

# run the full test suite on a local validator
anchor test

# deploy to devnet (never mainnet without an explicit decision)
solana config set --url devnet
anchor deploy --provider.cluster devnet
```

## Using the SDK

```ts
import { EscrowClient } from "./sdk";
import { BN } from "@coral-xyz/anchor";

const client = new EscrowClient(program);
const seed = new BN(Date.now());

const makeIx = await client.makeIx({
  maker: maker.publicKey,
  mintA,
  mintB,
  seed,
  deposit: new BN(100_000_000), // 100 token A at 6 decimals
  receive: new BN(250_000_000), // wants 250 token B
});
// add makeIx to a transaction, sign as maker, send.
```

## Tests covered

- make locks token A and records the deal
- take settles atomically: taker gets A, maker gets B, accounts close
- refund returns A to the maker and closes the accounts
- make rejects a zero deposit
- make rejects the same mint for A and B

## Status

Built and tested on localnet with Anchor. Not audited. Review and audit before any mainnet or value bearing use.
