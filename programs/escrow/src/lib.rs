//! Trustless SPL token escrow for atomic over the counter swaps.
//!
//! A maker locks `deposit` of mint A in a program owned vault and names the
//! `receive` amount of mint B they want in return. A taker can `take` the deal:
//! they pay mint B straight to the maker and receive mint A from the vault in
//! one atomic transaction. The maker can `refund` to reclaim mint A at any time
//! before the deal is taken. Works with both SPL Token and Token 2022 via the
//! token interface.

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{
        close_account, transfer_checked, CloseAccount, Mint, TokenAccount, TokenInterface,
        TransferChecked,
    },
};

declare_id!("4N3CiEWQT6m4zGfq3jCzw6RiYxzMiC2Uyu3tzSnvQNtW");

#[program]
pub mod escrow {
    use super::*;

    /// Maker opens an escrow: lock `deposit` of mint A, ask for `receive` of mint B.
    pub fn make(ctx: Context<Make>, seed: u64, deposit: u64, receive: u64) -> Result<()> {
        require!(deposit > 0, EscrowError::InvalidAmount);
        require!(receive > 0, EscrowError::InvalidAmount);
        require_keys_neq!(
            ctx.accounts.mint_a.key(),
            ctx.accounts.mint_b.key(),
            EscrowError::SameMint
        );

        ctx.accounts.escrow.set_inner(Escrow {
            seed,
            maker: ctx.accounts.maker.key(),
            mint_a: ctx.accounts.mint_a.key(),
            mint_b: ctx.accounts.mint_b.key(),
            receive,
            bump: ctx.bumps.escrow,
        });

        transfer_checked(
            ctx.accounts.deposit_to_vault_ctx(),
            deposit,
            ctx.accounts.mint_a.decimals,
        )
    }

    /// Taker fills the escrow: pay mint B to the maker, take mint A from the vault.
    pub fn take(ctx: Context<Take>) -> Result<()> {
        transfer_checked(
            ctx.accounts.pay_maker_ctx(),
            ctx.accounts.escrow.receive,
            ctx.accounts.mint_b.decimals,
        )?;
        ctx.accounts.release_to_taker_and_close()
    }

    /// Maker cancels the escrow and reclaims mint A.
    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        ctx.accounts.refund_to_maker_and_close()
    }
}

#[account]
#[derive(InitSpace)]
pub struct Escrow {
    pub seed: u64,
    pub maker: Pubkey,
    pub mint_a: Pubkey,
    pub mint_b: Pubkey,
    pub receive: u64,
    pub bump: u8,
}

#[error_code]
pub enum EscrowError {
    #[msg("Amount must be greater than zero")]
    InvalidAmount,
    #[msg("Mint A and mint B must be different")]
    SameMint,
}

#[derive(Accounts)]
#[instruction(seed: u64)]
pub struct Make<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,

    pub mint_a: Box<InterfaceAccount<'info, Mint>>,
    pub mint_b: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = mint_a,
        associated_token::authority = maker,
        associated_token::token_program = token_program,
    )]
    pub maker_ata_a: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init,
        payer = maker,
        space = 8 + Escrow::INIT_SPACE,
        seeds = [b"escrow", maker.key().as_ref(), seed.to_le_bytes().as_ref()],
        bump,
    )]
    pub escrow: Box<Account<'info, Escrow>>,

    #[account(
        init,
        payer = maker,
        associated_token::mint = mint_a,
        associated_token::authority = escrow,
        associated_token::token_program = token_program,
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,

    pub associated_token_program: Program<'info, AssociatedToken>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

impl<'info> Make<'info> {
    fn deposit_to_vault_ctx(&self) -> CpiContext<'_, '_, '_, 'info, TransferChecked<'info>> {
        CpiContext::new(
            self.token_program.key(),
            TransferChecked {
                from: self.maker_ata_a.to_account_info(),
                mint: self.mint_a.to_account_info(),
                to: self.vault.to_account_info(),
                authority: self.maker.to_account_info(),
            },
        )
    }
}

#[derive(Accounts)]
pub struct Take<'info> {
    #[account(mut)]
    pub taker: Signer<'info>,

    #[account(mut)]
    pub maker: SystemAccount<'info>,

    pub mint_a: Box<InterfaceAccount<'info, Mint>>,
    pub mint_b: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        init_if_needed,
        payer = taker,
        associated_token::mint = mint_a,
        associated_token::authority = taker,
        associated_token::token_program = token_program,
    )]
    pub taker_ata_a: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = mint_b,
        associated_token::authority = taker,
        associated_token::token_program = token_program,
    )]
    pub taker_ata_b: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = taker,
        associated_token::mint = mint_b,
        associated_token::authority = maker,
        associated_token::token_program = token_program,
    )]
    pub maker_ata_b: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        close = maker,
        has_one = maker,
        has_one = mint_a,
        has_one = mint_b,
        seeds = [b"escrow", maker.key().as_ref(), escrow.seed.to_le_bytes().as_ref()],
        bump = escrow.bump,
    )]
    pub escrow: Box<Account<'info, Escrow>>,

    #[account(
        mut,
        associated_token::mint = mint_a,
        associated_token::authority = escrow,
        associated_token::token_program = token_program,
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,

    pub associated_token_program: Program<'info, AssociatedToken>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

impl<'info> Take<'info> {
    fn pay_maker_ctx(&self) -> CpiContext<'_, '_, '_, 'info, TransferChecked<'info>> {
        CpiContext::new(
            self.token_program.key(),
            TransferChecked {
                from: self.taker_ata_b.to_account_info(),
                mint: self.mint_b.to_account_info(),
                to: self.maker_ata_b.to_account_info(),
                authority: self.taker.to_account_info(),
            },
        )
    }

    fn release_to_taker_and_close(&self) -> Result<()> {
        let seed = self.escrow.seed.to_le_bytes();
        let maker_key = self.maker.key();
        let signer_seeds: [&[&[u8]]; 1] =
            [&[b"escrow", maker_key.as_ref(), seed.as_ref(), &[self.escrow.bump]]];

        transfer_checked(
            CpiContext::new_with_signer(
                self.token_program.key(),
                TransferChecked {
                    from: self.vault.to_account_info(),
                    mint: self.mint_a.to_account_info(),
                    to: self.taker_ata_a.to_account_info(),
                    authority: self.escrow.to_account_info(),
                },
                &signer_seeds,
            ),
            self.vault.amount,
            self.mint_a.decimals,
        )?;

        close_account(CpiContext::new_with_signer(
            self.token_program.key(),
            CloseAccount {
                account: self.vault.to_account_info(),
                destination: self.maker.to_account_info(),
                authority: self.escrow.to_account_info(),
            },
            &signer_seeds,
        ))
    }
}

#[derive(Accounts)]
pub struct Refund<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,

    pub mint_a: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = mint_a,
        associated_token::authority = maker,
        associated_token::token_program = token_program,
    )]
    pub maker_ata_a: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        close = maker,
        has_one = maker,
        has_one = mint_a,
        seeds = [b"escrow", maker.key().as_ref(), escrow.seed.to_le_bytes().as_ref()],
        bump = escrow.bump,
    )]
    pub escrow: Box<Account<'info, Escrow>>,

    #[account(
        mut,
        associated_token::mint = mint_a,
        associated_token::authority = escrow,
        associated_token::token_program = token_program,
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,

    pub associated_token_program: Program<'info, AssociatedToken>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

impl<'info> Refund<'info> {
    fn refund_to_maker_and_close(&self) -> Result<()> {
        let seed = self.escrow.seed.to_le_bytes();
        let maker_key = self.maker.key();
        let signer_seeds: [&[&[u8]]; 1] =
            [&[b"escrow", maker_key.as_ref(), seed.as_ref(), &[self.escrow.bump]]];

        transfer_checked(
            CpiContext::new_with_signer(
                self.token_program.key(),
                TransferChecked {
                    from: self.vault.to_account_info(),
                    mint: self.mint_a.to_account_info(),
                    to: self.maker_ata_a.to_account_info(),
                    authority: self.escrow.to_account_info(),
                },
                &signer_seeds,
            ),
            self.vault.amount,
            self.mint_a.decimals,
        )?;

        close_account(CpiContext::new_with_signer(
            self.token_program.key(),
            CloseAccount {
                account: self.vault.to_account_info(),
                destination: self.maker.to_account_info(),
                authority: self.escrow.to_account_info(),
            },
            &signer_seeds,
        ))
    }
}
