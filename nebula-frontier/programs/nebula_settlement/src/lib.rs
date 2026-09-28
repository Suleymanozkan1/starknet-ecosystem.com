//! NEBULA FRONTIER settlement program (Anchor 1.x).
//!
//! NOT deployed in the MVP: the MVP settles through audited treasury transfers executed by
//! apps/blockchain-service (see docs/BLOCKCHAIN.md). This program is the on-chain successor:
//!
//! * `verify_reward`  — the game's reward signer attests a reward (id, player, amount). A PDA per
//!   reward id makes double claims impossible; the payout comes from a program vault.
//! * escrow           — a player-to-player trade escrow for SOL (deposit / release / refund).
//! * tournaments      — entry fees held by a tournament PDA, settled to winners by the authority
//!   with a capped house fee; refundable if cancelled.
//!
//! Every state change emits an event for indexers.

use anchor_lang::prelude::*;
use anchor_lang::system_program;

declare_id!("Huqa9xhLz97jhGsQVLuNovd2FuepHWnD9BRvcBifvPQH");

pub const CONFIG_SEED: &[u8] = b"config";
pub const VAULT_SEED: &[u8] = b"vault";
pub const REWARD_SEED: &[u8] = b"reward";
pub const ESCROW_SEED: &[u8] = b"escrow";
pub const TOURNAMENT_SEED: &[u8] = b"tournament";
pub const MAX_FEE_BPS: u16 = 1_000; // 10% hard cap on any house fee
pub const MAX_WINNERS: usize = 16;

#[program]
pub mod nebula_settlement {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, reward_signer: Pubkey, fee_bps: u16, max_reward_per_claim: u64) -> Result<()> {
        require!(fee_bps <= MAX_FEE_BPS, SettlementError::FeeTooHigh);
        let cfg = &mut ctx.accounts.config;
        cfg.authority = ctx.accounts.authority.key();
        cfg.reward_signer = reward_signer;
        cfg.fee_bps = fee_bps;
        cfg.max_reward_per_claim = max_reward_per_claim;
        cfg.paused = false;
        cfg.bump = ctx.bumps.config;
        cfg.vault_bump = ctx.bumps.vault;
        emit!(ConfigUpdated { authority: cfg.authority, reward_signer, fee_bps, paused: false });
        Ok(())
    }

    pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        let cfg = &mut ctx.accounts.config;
        cfg.paused = paused;
        emit!(ConfigUpdated { authority: cfg.authority, reward_signer: cfg.reward_signer, fee_bps: cfg.fee_bps, paused });
        Ok(())
    }

    /// Funds the reward vault (treasury → vault). Anyone may fund; only verified rewards leave it.
    pub fn fund_vault(ctx: Context<FundVault>, amount: u64) -> Result<()> {
        require!(amount > 0, SettlementError::InvalidAmount);
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                system_program::Transfer { from: ctx.accounts.funder.to_account_info(), to: ctx.accounts.vault.to_account_info() },
            ),
            amount,
        )?;
        emit!(VaultFunded { funder: ctx.accounts.funder.key(), amount });
        Ok(())
    }

    /// Reward verification + payout. The reward signer (game server key) must co-sign; the reward
    /// receipt PDA (seeded by reward_id) can only be created once → no duplicate claims.
    pub fn verify_reward(ctx: Context<VerifyReward>, reward_id: [u8; 32], amount: u64) -> Result<()> {
        let cfg = &ctx.accounts.config;
        require!(!cfg.paused, SettlementError::Paused);
        require!(amount > 0, SettlementError::InvalidAmount);
        require!(amount <= cfg.max_reward_per_claim, SettlementError::RewardAboveCap);
        let vault = &ctx.accounts.vault;
        let rent_floor = Rent::get()?.minimum_balance(0);
        require!(vault.get_lamports().saturating_sub(rent_floor) >= amount, SettlementError::VaultInsufficient);

        let receipt = &mut ctx.accounts.receipt;
        receipt.reward_id = reward_id;
        receipt.player = ctx.accounts.player.key();
        receipt.amount = amount;
        receipt.claimed_at = Clock::get()?.unix_timestamp;
        receipt.bump = ctx.bumps.receipt;

        let seeds: &[&[u8]] = &[VAULT_SEED, &[cfg.vault_bump]];
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.key(),
                system_program::Transfer { from: vault.to_account_info(), to: ctx.accounts.player.to_account_info() },
                &[seeds],
            ),
            amount,
        )?;
        emit!(RewardVerified { reward_id, player: receipt.player, amount });
        Ok(())
    }

    // ------------------------------------------------------------------ escrow (SOL)
    pub fn open_escrow(ctx: Context<OpenEscrow>, escrow_id: u64, amount: u64, expires_at: i64) -> Result<()> {
        require!(amount > 0, SettlementError::InvalidAmount);
        require!(expires_at > Clock::get()?.unix_timestamp, SettlementError::InvalidExpiry);
        let maker = ctx.accounts.maker.key();
        let taker = ctx.accounts.taker.key();
        {
            let e = &mut ctx.accounts.escrow;
            e.escrow_id = escrow_id;
            e.maker = maker;
            e.taker = taker;
            e.amount = amount;
            e.expires_at = expires_at;
            e.bump = ctx.bumps.escrow;
        }
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                system_program::Transfer { from: ctx.accounts.maker.to_account_info(), to: ctx.accounts.escrow.to_account_info() },
            ),
            amount,
        )?;
        emit!(EscrowOpened { escrow_id, maker, taker, amount });
        Ok(())
    }

    /// Authority (game server, after verifying the off-chain item delivery) releases to the taker.
    pub fn release_escrow(ctx: Context<SettleEscrow>) -> Result<()> {
        require!(!ctx.accounts.config.paused, SettlementError::Paused);
        let amount = ctx.accounts.escrow.amount;
        ctx.accounts.escrow.sub_lamports(amount)?;
        ctx.accounts.taker.add_lamports(amount)?;
        emit!(EscrowSettled { escrow_id: ctx.accounts.escrow.escrow_id, to: ctx.accounts.taker.key(), amount, released: true });
        Ok(())
        // account closed to maker via `close = maker` (rent refund)
    }

    /// Maker refund after expiry (or authority cancel at any time).
    pub fn refund_escrow(ctx: Context<RefundEscrow>) -> Result<()> {
        let e = &ctx.accounts.escrow;
        let is_authority = ctx.accounts.caller.key() == ctx.accounts.config.authority;
        require!(is_authority || Clock::get()?.unix_timestamp >= e.expires_at, SettlementError::NotExpired);
        emit!(EscrowSettled { escrow_id: e.escrow_id, to: e.maker, amount: e.amount, released: false });
        Ok(())
        // all lamports (amount + rent) return to maker through `close = maker`
    }

    // ------------------------------------------------------------------ tournaments
    pub fn create_tournament(ctx: Context<CreateTournament>, tournament_id: u64, entry_fee: u64, max_players: u16) -> Result<()> {
        require!(max_players >= 2, SettlementError::InvalidAmount);
        let t = &mut ctx.accounts.tournament;
        t.tournament_id = tournament_id;
        t.entry_fee = entry_fee;
        t.max_players = max_players;
        t.players = 0;
        t.pot = 0;
        t.state = TournamentState::Open as u8;
        t.bump = ctx.bumps.tournament;
        emit!(TournamentCreated { tournament_id, entry_fee, max_players });
        Ok(())
    }

    pub fn join_tournament(ctx: Context<JoinTournament>) -> Result<()> {
        let t = &mut ctx.accounts.tournament;
        require!(t.state == TournamentState::Open as u8, SettlementError::TournamentClosed);
        require!(t.players < t.max_players, SettlementError::TournamentFull);
        if t.entry_fee > 0 {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.key(),
                    system_program::Transfer { from: ctx.accounts.player.to_account_info(), to: t.to_account_info() },
                ),
                t.entry_fee,
            )?;
        }
        t.players = t.players.checked_add(1).ok_or(SettlementError::Overflow)?;
        t.pot = t.pot.checked_add(t.entry_fee).ok_or(SettlementError::Overflow)?;
        let entry = &mut ctx.accounts.entry;
        entry.player = ctx.accounts.player.key();
        entry.tournament = t.key();
        entry.bump = ctx.bumps.entry;
        emit!(TournamentJoined { tournament_id: t.tournament_id, player: entry.player });
        Ok(())
    }

    /// Settles the pot: `payouts` (lamports) are paid to `remaining_accounts` in order; the house fee
    /// (≤ fee_bps of the pot) goes to the fee receiver. Sum(payouts) + fee must equal the pot.
    pub fn settle_tournament<'info>(ctx: Context<'info, SettleTournament<'info>>, payouts: Vec<u64>) -> Result<()> {
        let cfg = &ctx.accounts.config;
        require!(!cfg.paused, SettlementError::Paused);
        let winners = ctx.remaining_accounts;
        require!(!payouts.is_empty() && payouts.len() <= MAX_WINNERS, SettlementError::InvalidWinners);
        require!(winners.len() == payouts.len(), SettlementError::InvalidWinners);
        let t = &mut ctx.accounts.tournament;
        require!(t.state == TournamentState::Open as u8, SettlementError::TournamentClosed);
        let total: u64 = payouts.iter().try_fold(0u64, |acc, p| acc.checked_add(*p)).ok_or(SettlementError::Overflow)?;
        require!(total <= t.pot, SettlementError::PayoutExceedsPot);
        let fee = t.pot - total;
        let max_fee = (t.pot as u128 * cfg.fee_bps as u128 / 10_000u128) as u64;
        require!(fee <= max_fee, SettlementError::FeeTooHigh);
        for (acc, amount) in winners.iter().zip(payouts.iter()) {
            require!(acc.is_writable, SettlementError::InvalidWinners);
            if *amount > 0 {
                t.sub_lamports(*amount)?;
                acc.add_lamports(*amount)?;
            }
        }
        if fee > 0 {
            t.sub_lamports(fee)?;
            ctx.accounts.fee_receiver.add_lamports(fee)?;
        }
        t.state = TournamentState::Settled as u8;
        emit!(TournamentSettled { tournament_id: t.tournament_id, pot: t.pot, fee, winners: payouts.len() as u8 });
        t.pot = 0;
        Ok(())
    }

    /// Cancels an open tournament: each entrant's fee is refunded when they close their entry.
    pub fn cancel_tournament(ctx: Context<AdminTournament>) -> Result<()> {
        let t = &mut ctx.accounts.tournament;
        require!(t.state == TournamentState::Open as u8, SettlementError::TournamentClosed);
        t.state = TournamentState::Cancelled as u8;
        emit!(TournamentCancelled { tournament_id: t.tournament_id });
        Ok(())
    }

    pub fn refund_entry(ctx: Context<RefundEntry>) -> Result<()> {
        let t = &mut ctx.accounts.tournament;
        require!(t.state == TournamentState::Cancelled as u8, SettlementError::TournamentClosed);
        let fee = t.entry_fee;
        if fee > 0 {
            t.sub_lamports(fee)?;
            ctx.accounts.player.add_lamports(fee)?;
            t.pot = t.pot.checked_sub(fee).ok_or(SettlementError::Overflow)?;
        }
        emit!(TournamentRefunded { tournament_id: t.tournament_id, player: ctx.accounts.player.key(), amount: fee });
        Ok(())
    }
}

// ============================================================ accounts

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub authority: Pubkey,
    pub reward_signer: Pubkey,
    pub fee_bps: u16,
    pub max_reward_per_claim: u64,
    pub paused: bool,
    pub bump: u8,
    pub vault_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct RewardReceipt {
    pub reward_id: [u8; 32],
    pub player: Pubkey,
    pub amount: u64,
    pub claimed_at: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Escrow {
    pub escrow_id: u64,
    pub maker: Pubkey,
    pub taker: Pubkey,
    pub amount: u64,
    pub expires_at: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Tournament {
    pub tournament_id: u64,
    pub entry_fee: u64,
    pub max_players: u16,
    pub players: u16,
    pub pot: u64,
    pub state: u8,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct TournamentEntry {
    pub player: Pubkey,
    pub tournament: Pubkey,
    pub bump: u8,
}

#[repr(u8)]
pub enum TournamentState {
    Open = 0,
    Settled = 1,
    Cancelled = 2,
}

// ============================================================ instruction contexts

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init, payer = authority, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    /// CHECK: system-owned PDA holding reward lamports; only moved with program signer seeds.
    #[account(mut, seeds = [VAULT_SEED], bump)]
    pub vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = authority @ SettlementError::Unauthorized)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct FundVault<'info> {
    #[account(mut)]
    pub funder: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// CHECK: vault PDA validated by seeds.
    #[account(mut, seeds = [VAULT_SEED], bump = config.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(reward_id: [u8; 32])]
pub struct VerifyReward<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// The game server's reward signing key (must match config.reward_signer).
    #[account(address = config.reward_signer @ SettlementError::Unauthorized)]
    pub reward_signer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// CHECK: vault PDA validated by seeds.
    #[account(mut, seeds = [VAULT_SEED], bump = config.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(init, payer = payer, space = 8 + RewardReceipt::INIT_SPACE, seeds = [REWARD_SEED, reward_id.as_ref()], bump)]
    pub receipt: Account<'info, RewardReceipt>,
    /// CHECK: any wallet may receive a verified reward.
    #[account(mut)]
    pub player: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(escrow_id: u64)]
pub struct OpenEscrow<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,
    /// CHECK: counterparty wallet recorded in the escrow.
    pub taker: UncheckedAccount<'info>,
    #[account(init, payer = maker, space = 8 + Escrow::INIT_SPACE, seeds = [ESCROW_SEED, maker.key().as_ref(), &escrow_id.to_le_bytes()], bump)]
    pub escrow: Account<'info, Escrow>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettleEscrow<'info> {
    #[account(address = config.authority @ SettlementError::Unauthorized)]
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, close = maker, has_one = maker, has_one = taker,
        seeds = [ESCROW_SEED, maker.key().as_ref(), &escrow.escrow_id.to_le_bytes()], bump = escrow.bump)]
    pub escrow: Account<'info, Escrow>,
    /// CHECK: validated by has_one.
    #[account(mut)]
    pub maker: UncheckedAccount<'info>,
    /// CHECK: validated by has_one.
    #[account(mut)]
    pub taker: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct RefundEscrow<'info> {
    pub caller: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, close = maker, has_one = maker,
        seeds = [ESCROW_SEED, maker.key().as_ref(), &escrow.escrow_id.to_le_bytes()], bump = escrow.bump)]
    pub escrow: Account<'info, Escrow>,
    /// CHECK: validated by has_one.
    #[account(mut)]
    pub maker: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(tournament_id: u64)]
pub struct CreateTournament<'info> {
    #[account(mut, address = config.authority @ SettlementError::Unauthorized)]
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(init, payer = authority, space = 8 + Tournament::INIT_SPACE, seeds = [TOURNAMENT_SEED, &tournament_id.to_le_bytes()], bump)]
    pub tournament: Account<'info, Tournament>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct JoinTournament<'info> {
    #[account(mut)]
    pub player: Signer<'info>,
    #[account(mut, seeds = [TOURNAMENT_SEED, &tournament.tournament_id.to_le_bytes()], bump = tournament.bump)]
    pub tournament: Account<'info, Tournament>,
    #[account(init, payer = player, space = 8 + TournamentEntry::INIT_SPACE, seeds = [TOURNAMENT_SEED, tournament.key().as_ref(), player.key().as_ref()], bump)]
    pub entry: Account<'info, TournamentEntry>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettleTournament<'info> {
    #[account(address = config.authority @ SettlementError::Unauthorized)]
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [TOURNAMENT_SEED, &tournament.tournament_id.to_le_bytes()], bump = tournament.bump)]
    pub tournament: Account<'info, Tournament>,
    /// CHECK: house fee destination (treasury).
    #[account(mut)]
    pub fee_receiver: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct AdminTournament<'info> {
    #[account(address = config.authority @ SettlementError::Unauthorized)]
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [TOURNAMENT_SEED, &tournament.tournament_id.to_le_bytes()], bump = tournament.bump)]
    pub tournament: Account<'info, Tournament>,
}

#[derive(Accounts)]
pub struct RefundEntry<'info> {
    #[account(mut)]
    pub player: Signer<'info>,
    #[account(mut, seeds = [TOURNAMENT_SEED, &tournament.tournament_id.to_le_bytes()], bump = tournament.bump)]
    pub tournament: Account<'info, Tournament>,
    #[account(mut, close = player, has_one = player, has_one = tournament,
        seeds = [TOURNAMENT_SEED, tournament.key().as_ref(), player.key().as_ref()], bump = entry.bump)]
    pub entry: Account<'info, TournamentEntry>,
}

// ============================================================ events & errors

#[event]
pub struct ConfigUpdated { pub authority: Pubkey, pub reward_signer: Pubkey, pub fee_bps: u16, pub paused: bool }
#[event]
pub struct VaultFunded { pub funder: Pubkey, pub amount: u64 }
#[event]
pub struct RewardVerified { pub reward_id: [u8; 32], pub player: Pubkey, pub amount: u64 }
#[event]
pub struct EscrowOpened { pub escrow_id: u64, pub maker: Pubkey, pub taker: Pubkey, pub amount: u64 }
#[event]
pub struct EscrowSettled { pub escrow_id: u64, pub to: Pubkey, pub amount: u64, pub released: bool }
#[event]
pub struct TournamentCreated { pub tournament_id: u64, pub entry_fee: u64, pub max_players: u16 }
#[event]
pub struct TournamentJoined { pub tournament_id: u64, pub player: Pubkey }
#[event]
pub struct TournamentSettled { pub tournament_id: u64, pub pot: u64, pub fee: u64, pub winners: u8 }
#[event]
pub struct TournamentCancelled { pub tournament_id: u64 }
#[event]
pub struct TournamentRefunded { pub tournament_id: u64, pub player: Pubkey, pub amount: u64 }

#[error_code]
pub enum SettlementError {
    #[msg("Unauthorized signer")]
    Unauthorized,
    #[msg("Settlement is paused")]
    Paused,
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Reward exceeds the per-claim cap")]
    RewardAboveCap,
    #[msg("Reward vault has insufficient funds")]
    VaultInsufficient,
    #[msg("Fee above the configured cap")]
    FeeTooHigh,
    #[msg("Invalid expiry")]
    InvalidExpiry,
    #[msg("Escrow has not expired")]
    NotExpired,
    #[msg("Tournament is not open")]
    TournamentClosed,
    #[msg("Tournament is full")]
    TournamentFull,
    #[msg("Invalid winners list")]
    InvalidWinners,
    #[msg("Payouts exceed the pot")]
    PayoutExceedsPot,
    #[msg("Arithmetic overflow")]
    Overflow,
}
