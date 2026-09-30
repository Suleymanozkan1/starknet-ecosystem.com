//! On-chain tests: the SBF build of the program (`target/deploy/nebula_settlement.so`, produced by
//! `anchor build` / `cargo build-sbf`) runs inside LiteSVM, an in-process Solana VM. No validator,
//! no network, no real keys (every keypair is generated per test).
//!
//! Run: `cd programs && anchor build && cargo test -p nebula_settlement`.
//! If the .so has not been built yet these tests fail with a pointer to the build command.

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::bpf_loader_upgradeable;
use anchor_lang::{system_program, AccountDeserialize, InstructionData, ToAccountMetas};
use litesvm::LiteSVM;
use nebula_settlement::{
    accounts, instruction, Config, Escrow, RewardReceipt, SettlementError, Tournament, TournamentState, CONFIG_SEED,
    ESCROW_SEED, MAX_FEE_BPS, REWARD_SEED, TOURNAMENT_SEED, VAULT_SEED,
};
use solana_clock::Clock;
use solana_instruction::{error::InstructionError, AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

const SOL: u64 = 1_000_000_000;
const PER_CLAIM: u64 = SOL;
const PER_EPOCH: u64 = 2 * SOL;
const EPOCH_SECS: i64 = 86_400;
const FEE_BPS: u16 = 500; // 5 %

fn program_so() -> Vec<u8> {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../target/deploy/nebula_settlement.so");
    std::fs::read(path).unwrap_or_else(|e| {
        panic!("{path}: {e}. Build the SBF program first: `cd programs && anchor build` (or `cargo build-sbf`).")
    })
}

fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &nebula_settlement::ID).0
}
fn config_pda() -> Pubkey {
    pda(&[CONFIG_SEED])
}
fn vault_pda() -> Pubkey {
    pda(&[VAULT_SEED])
}
fn program_data_pda() -> Pubkey {
    Pubkey::find_program_address(&[nebula_settlement::ID.as_ref()], &bpf_loader_upgradeable::ID).0
}

struct Env {
    svm: LiteSVM,
    /// Upgrade authority of the program == initial config authority.
    admin: Keypair,
    reward_signer: Keypair,
}

impl Env {
    /// Loads the .so through the upgradeable loader and makes `admin` its upgrade authority.
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program(nebula_settlement::ID, &program_so()).expect("load program");
        let admin = Keypair::new();
        // LiteSVM creates ProgramData with no upgrade authority; patch it in. Layout (bincode):
        // [0..4) enum tag = 3 (ProgramData), [4..12) slot, [12] Option tag, [13..45) authority.
        let pd = program_data_pda();
        let mut acc = svm.get_account(&pd).expect("programdata account");
        assert_eq!(acc.data[0..4], 3u32.to_le_bytes());
        acc.data[12] = 1;
        acc.data[13..45].copy_from_slice(admin.pubkey().as_ref());
        svm.set_account(pd, acc).unwrap();
        svm.airdrop(&admin.pubkey(), 100 * SOL).unwrap();
        Env { svm, admin, reward_signer: Keypair::new() }
    }

    fn funded(&mut self) -> Keypair {
        let k = Keypair::new();
        self.svm.airdrop(&k.pubkey(), 50 * SOL).unwrap();
        k
    }

    fn send(&mut self, ix: Instruction, payer: &Keypair, extra: &[&Keypair]) -> Result<(), InstructionError> {
        let mut signers: Vec<&Keypair> = vec![payer];
        signers.extend_from_slice(extra);
        let msg = Message::new(&[ix], Some(&payer.pubkey()));
        let tx = Transaction::new(&signers, msg, self.svm.latest_blockhash());
        let res = self.svm.send_transaction(tx);
        self.svm.expire_blockhash();
        match res {
            Ok(_) => Ok(()),
            Err(failed) => match failed.err {
                solana_transaction::TransactionError::InstructionError(_, e) => Err(e),
                other => panic!("unexpected transaction error {other:?}\n{:#?}", failed.meta.logs),
            },
        }
    }

    fn balance(&self, k: &Pubkey) -> u64 {
        self.svm.get_account(k).map(|a| a.lamports).unwrap_or(0)
    }

    fn account<T: AccountDeserialize>(&self, k: &Pubkey) -> T {
        let acc = self.svm.get_account(k).expect("account exists");
        T::try_deserialize(&mut acc.data.as_slice()).expect("deserialize")
    }

    fn exists(&self, k: &Pubkey) -> bool {
        self.svm.get_account(k).is_some_and(|a| a.lamports > 0)
    }

    fn now(&self) -> i64 {
        self.svm.get_sysvar::<Clock>().unix_timestamp
    }

    fn warp(&mut self, secs: i64) {
        let mut c = self.svm.get_sysvar::<Clock>();
        c.unix_timestamp += secs;
        c.slot += 1;
        self.svm.set_sysvar(&c);
    }

    fn initialize_ix(&self, authority: &Pubkey, fee_bps: u16, per_claim: u64, per_epoch: u64, epoch: i64) -> Instruction {
        ix(
            accounts::Initialize {
                authority: *authority,
                program: nebula_settlement::ID,
                program_data: program_data_pda(),
                config: config_pda(),
                vault: vault_pda(),
                system_program: system_program::ID,
            },
            instruction::Initialize {
                reward_signer: self.reward_signer.pubkey(),
                fee_bps,
                max_reward_per_claim: per_claim,
                max_emission_per_epoch: per_epoch,
                epoch_duration_secs: epoch,
            },
        )
    }

    fn initialize(&mut self) {
        let ix = self.initialize_ix(&self.admin.pubkey(), FEE_BPS, PER_CLAIM, PER_EPOCH, EPOCH_SECS);
        let admin = self.admin.insecure_clone();
        self.send(ix, &admin, &[]).expect("initialize");
    }

    fn fund_vault(&mut self, amount: u64) {
        let funder = self.funded();
        let ix = ix(
            accounts::FundVault {
                funder: funder.pubkey(),
                config: config_pda(),
                vault: vault_pda(),
                system_program: system_program::ID,
            },
            instruction::FundVault { amount },
        );
        self.send(ix, &funder, &[]).expect("fund_vault");
    }

    fn verify_reward(&mut self, signer: &Keypair, id: u8, player: &Pubkey, amount: u64) -> Result<(), InstructionError> {
        let reward_id = [id; 32];
        let payer = self.admin.insecure_clone();
        let ix = ix(
            accounts::VerifyReward {
                payer: payer.pubkey(),
                reward_signer: signer.pubkey(),
                config: config_pda(),
                vault: vault_pda(),
                receipt: pda(&[REWARD_SEED, &reward_id]),
                player: *player,
                system_program: system_program::ID,
            },
            instruction::VerifyReward { reward_id, amount },
        );
        self.send(ix, &payer, &[signer])
    }

    fn admin_ix(&self, authority: &Pubkey, data: impl InstructionData) -> Instruction {
        ix(accounts::AdminOnly { authority: *authority, config: config_pda() }, data)
    }
}

fn ix(accs: impl ToAccountMetas, data: impl InstructionData) -> Instruction {
    Instruction { program_id: nebula_settlement::ID, accounts: accs.to_account_metas(None), data: data.data() }
}

fn code(e: SettlementError) -> InstructionError {
    InstructionError::Custom(u32::from(e))
}

// ------------------------------------------------------------------ admin

#[test]
fn initialize_is_restricted_to_the_upgrade_authority_and_validates_params() {
    let mut env = Env::new();
    let stranger = env.funded();

    let ix = env.initialize_ix(&stranger.pubkey(), FEE_BPS, PER_CLAIM, PER_EPOCH, EPOCH_SECS);
    assert_eq!(env.send(ix, &stranger, &[]), Err(code(SettlementError::Unauthorized)));

    let admin = env.admin.insecure_clone();
    let ix = env.initialize_ix(&admin.pubkey(), MAX_FEE_BPS + 1, PER_CLAIM, PER_EPOCH, EPOCH_SECS);
    assert_eq!(env.send(ix, &admin, &[]), Err(code(SettlementError::FeeTooHigh)));
    let ix = env.initialize_ix(&admin.pubkey(), FEE_BPS, PER_EPOCH + 1, PER_EPOCH, EPOCH_SECS);
    assert_eq!(env.send(ix, &admin, &[]), Err(code(SettlementError::InvalidConfig)));
    let ix = env.initialize_ix(&admin.pubkey(), FEE_BPS, PER_CLAIM, PER_EPOCH, 0);
    assert_eq!(env.send(ix, &admin, &[]), Err(code(SettlementError::InvalidConfig)));

    env.initialize();
    let cfg: Config = env.account(&config_pda());
    assert_eq!(cfg.authority, admin.pubkey());
    assert_eq!(cfg.pending_authority, Pubkey::default());
    assert_eq!(cfg.reward_signer, env.reward_signer.pubkey());
    assert_eq!((cfg.fee_bps, cfg.max_reward_per_claim, cfg.max_emission_per_epoch), (FEE_BPS, PER_CLAIM, PER_EPOCH));
    assert_eq!((cfg.epoch_duration_secs, cfg.epoch_start, cfg.epoch_emitted, cfg.paused), (EPOCH_SECS, env.now(), 0, false));

    // The config is a singleton PDA: a second initialize fails (account already in use).
    let ix = env.initialize_ix(&admin.pubkey(), FEE_BPS, PER_CLAIM, PER_EPOCH, EPOCH_SECS);
    assert!(env.send(ix, &admin, &[]).is_err());
}

#[test]
fn admin_instructions_check_authority_and_transfer_in_two_steps() {
    let mut env = Env::new();
    env.initialize();
    let admin = env.admin.insecure_clone();
    let stranger = env.funded();
    let successor = env.funded();
    let new_signer = Keypair::new().pubkey();
    let update = |signer| instruction::UpdateConfig {
        reward_signer: signer,
        fee_bps: 100,
        max_reward_per_claim: 10,
        max_emission_per_epoch: 20,
        epoch_duration_secs: 60,
    };

    let ixs = env.admin_ix(&stranger.pubkey(), update(new_signer));
    assert_eq!(env.send(ixs, &stranger, &[]), Err(code(SettlementError::Unauthorized)));
    let ixs = env.admin_ix(&stranger.pubkey(), instruction::SetPaused { paused: true });
    assert_eq!(env.send(ixs, &stranger, &[]), Err(code(SettlementError::Unauthorized)));
    let ixs = env.admin_ix(&admin.pubkey(), instruction::UpdateConfig { fee_bps: MAX_FEE_BPS + 1, ..update(new_signer) });
    assert_eq!(env.send(ixs, &admin, &[]), Err(code(SettlementError::FeeTooHigh)));

    let ixs = env.admin_ix(&admin.pubkey(), update(new_signer));
    env.send(ixs, &admin, &[]).unwrap();
    let cfg: Config = env.account(&config_pda());
    assert_eq!((cfg.reward_signer, cfg.fee_bps, cfg.max_reward_per_claim, cfg.max_emission_per_epoch), (new_signer, 100, 10, 20));

    // Nobody can accept while no transfer is pending.
    let accept = |k: &Keypair| ix(accounts::AcceptAuthority { new_authority: k.pubkey(), config: config_pda() }, instruction::AcceptAuthority {});
    assert_eq!(env.send(accept(&successor), &successor, &[]), Err(code(SettlementError::Unauthorized)));

    let ixs = env.admin_ix(&stranger.pubkey(), instruction::ProposeAuthority { new_authority: stranger.pubkey() });
    assert_eq!(env.send(ixs, &stranger, &[]), Err(code(SettlementError::Unauthorized)));
    let ixs = env.admin_ix(&admin.pubkey(), instruction::ProposeAuthority { new_authority: successor.pubkey() });
    env.send(ixs, &admin, &[]).unwrap();
    assert_eq!(env.send(accept(&stranger), &stranger, &[]), Err(code(SettlementError::Unauthorized)));
    env.send(accept(&successor), &successor, &[]).unwrap();

    let cfg: Config = env.account(&config_pda());
    assert_eq!((cfg.authority, cfg.pending_authority), (successor.pubkey(), Pubkey::default()));
    // The old authority lost its rights; the new one has them.
    let ixs = env.admin_ix(&admin.pubkey(), instruction::SetPaused { paused: true });
    assert_eq!(env.send(ixs, &admin, &[]), Err(code(SettlementError::Unauthorized)));
    let ixs = env.admin_ix(&successor.pubkey(), instruction::SetPaused { paused: true });
    env.send(ixs, &successor, &[]).unwrap();
    assert!(env.account::<Config>(&config_pda()).paused);
}

// ------------------------------------------------------------------ rewards

#[test]
fn verify_reward_enforces_signer_caps_uniqueness_and_pause() {
    let mut env = Env::new();
    env.initialize();
    env.fund_vault(10 * SOL);
    let signer = env.reward_signer.insecure_clone();
    let player = Keypair::new().pubkey();

    let impostor = Keypair::new();
    assert_eq!(env.verify_reward(&impostor, 1, &player, SOL / 2), Err(code(SettlementError::Unauthorized)));
    assert_eq!(env.verify_reward(&signer, 1, &player, 0), Err(code(SettlementError::InvalidAmount)));
    assert_eq!(env.verify_reward(&signer, 1, &player, PER_CLAIM + 1), Err(code(SettlementError::RewardAboveCap)));

    let vault_before = env.balance(&vault_pda());
    env.verify_reward(&signer, 1, &player, PER_CLAIM).unwrap();
    assert_eq!(env.balance(&player), PER_CLAIM);
    assert_eq!(env.balance(&vault_pda()), vault_before - PER_CLAIM);
    let receipt: RewardReceipt = env.account(&pda(&[REWARD_SEED, &[1u8; 32]]));
    assert_eq!((receipt.player, receipt.amount), (player, PER_CLAIM));

    // Same reward id twice → receipt PDA already exists → rejected, no second payout.
    assert!(env.verify_reward(&signer, 1, &player, PER_CLAIM).is_err());
    assert_eq!(env.balance(&player), PER_CLAIM);

    // Per-epoch emission cap (2 SOL): second claim fills it, third is rejected.
    env.verify_reward(&signer, 2, &player, PER_CLAIM).unwrap();
    assert_eq!(env.verify_reward(&signer, 3, &player, 1), Err(code(SettlementError::EmissionCapReached)));
    assert_eq!(env.account::<Config>(&config_pda()).epoch_emitted, PER_EPOCH);

    // After the epoch elapses the counter rolls over.
    env.warp(EPOCH_SECS);
    env.verify_reward(&signer, 3, &player, 1).unwrap();
    let cfg: Config = env.account(&config_pda());
    assert_eq!((cfg.epoch_emitted, cfg.epoch_start), (1, env.now()));

    // Paused → rejected.
    let admin = env.admin.insecure_clone();
    let ixs = env.admin_ix(&admin.pubkey(), instruction::SetPaused { paused: true });
    env.send(ixs, &admin, &[]).unwrap();
    assert_eq!(env.verify_reward(&signer, 4, &player, 1), Err(code(SettlementError::Paused)));
}

#[test]
fn verify_reward_keeps_the_vault_rent_floor() {
    let mut env = Env::new();
    env.initialize();
    env.fund_vault(PER_CLAIM / 2);
    let signer = env.reward_signer.insecure_clone();
    let player = Keypair::new().pubkey();
    assert_eq!(env.verify_reward(&signer, 9, &player, PER_CLAIM / 2), Err(code(SettlementError::VaultInsufficient)));
    env.verify_reward(&signer, 9, &player, PER_CLAIM / 4).unwrap();
}

// ------------------------------------------------------------------ escrow

fn open_escrow(env: &mut Env, maker: &Keypair, taker: &Pubkey, id: u64, amount: u64, expires_at: i64) -> Result<Pubkey, InstructionError> {
    let escrow = pda(&[ESCROW_SEED, maker.pubkey().as_ref(), &id.to_le_bytes()]);
    let ixs = ix(
        accounts::OpenEscrow { maker: maker.pubkey(), taker: *taker, config: config_pda(), escrow, system_program: system_program::ID },
        instruction::OpenEscrow { escrow_id: id, amount, expires_at },
    );
    env.send(ixs, maker, &[]).map(|_| escrow)
}

#[test]
fn escrow_release_and_refund_rules() {
    let mut env = Env::new();
    env.initialize();
    let admin = env.admin.insecure_clone();
    let maker = env.funded();
    let taker = Keypair::new().pubkey();
    let expires = env.now() + 3_600;

    assert_eq!(open_escrow(&mut env, &maker, &taker, 1, 0, expires), Err(code(SettlementError::InvalidAmount)));
    let now = env.now();
    assert_eq!(open_escrow(&mut env, &maker, &taker, 1, SOL, now), Err(code(SettlementError::InvalidExpiry)));

    // Release: authority only, taker gets the amount, the escrow closes (rent back to the maker).
    let escrow = open_escrow(&mut env, &maker, &taker, 1, SOL, expires).unwrap();
    assert_eq!(env.account::<Escrow>(&escrow).amount, SOL);
    let release = |auth: &Pubkey| {
        ix(accounts::SettleEscrow { authority: *auth, config: config_pda(), escrow, maker: maker.pubkey(), taker }, instruction::ReleaseEscrow {})
    };
    assert_eq!(env.send(release(&maker.pubkey()), &maker, &[]), Err(code(SettlementError::Unauthorized)));
    let maker_before = env.balance(&maker.pubkey());
    let rent = env.balance(&escrow) - SOL;
    env.send(release(&admin.pubkey()), &admin, &[]).unwrap();
    assert_eq!(env.balance(&taker), SOL);
    assert_eq!(env.balance(&maker.pubkey()), maker_before + rent);
    assert!(!env.exists(&escrow));

    // Refund: the maker must wait for expiry; the authority may cancel at any time.
    let refund = |caller: &Pubkey, escrow: Pubkey| {
        ix(accounts::RefundEscrow { caller: *caller, config: config_pda(), escrow, maker: maker.pubkey() }, instruction::RefundEscrow {})
    };
    let e2 = open_escrow(&mut env, &maker, &taker, 2, SOL, expires).unwrap();
    assert_eq!(env.send(refund(&maker.pubkey(), e2), &maker, &[]), Err(code(SettlementError::NotExpired)));
    let before = env.balance(&maker.pubkey());
    let locked = env.balance(&e2);
    env.send(refund(&admin.pubkey(), e2), &admin, &[]).unwrap();
    assert_eq!(env.balance(&maker.pubkey()), before + locked);
    assert!(!env.exists(&e2));

    let e3 = open_escrow(&mut env, &maker, &taker, 3, SOL, expires).unwrap();
    env.warp(3_600);
    env.send(refund(&maker.pubkey(), e3), &maker, &[]).unwrap();
    assert!(!env.exists(&e3));
    assert_eq!(env.balance(&taker), SOL, "refunds never pay the taker");

    // Opening is rejected while paused.
    let ixs = env.admin_ix(&admin.pubkey(), instruction::SetPaused { paused: true });
    env.send(ixs, &admin, &[]).unwrap();
    let later = env.now() + 60;
    assert_eq!(open_escrow(&mut env, &maker, &taker, 4, SOL, later), Err(code(SettlementError::Paused)));
}

// ------------------------------------------------------------------ tournaments

fn tournament_pda(id: u64) -> Pubkey {
    pda(&[TOURNAMENT_SEED, &id.to_le_bytes()])
}
fn entry_pda(t: &Pubkey, player: &Pubkey) -> Pubkey {
    pda(&[TOURNAMENT_SEED, t.as_ref(), player.as_ref()])
}

fn create_tournament(env: &mut Env, auth: &Keypair, id: u64, fee: u64, max: u16) -> Result<Pubkey, InstructionError> {
    let t = tournament_pda(id);
    let ixs = ix(
        accounts::CreateTournament { authority: auth.pubkey(), config: config_pda(), tournament: t, system_program: system_program::ID },
        instruction::CreateTournament { tournament_id: id, entry_fee: fee, max_players: max },
    );
    env.send(ixs, auth, &[]).map(|_| t)
}

fn join(env: &mut Env, t: &Pubkey, player: &Keypair) -> Result<(), InstructionError> {
    let ixs = ix(
        accounts::JoinTournament {
            player: player.pubkey(),
            config: config_pda(),
            tournament: *t,
            entry: entry_pda(t, &player.pubkey()),
            system_program: system_program::ID,
        },
        instruction::JoinTournament {},
    );
    env.send(ixs, player, &[])
}

fn settle(env: &mut Env, auth: &Keypair, t: &Pubkey, fee_receiver: &Pubkey, winners: &[Pubkey], payouts: Vec<u64>) -> Result<(), InstructionError> {
    let mut metas = accounts::SettleTournament { authority: auth.pubkey(), config: config_pda(), tournament: *t, fee_receiver: *fee_receiver }
        .to_account_metas(None);
    metas.extend(winners.iter().map(|w| AccountMeta::new(*w, false)));
    let ixs = Instruction { program_id: nebula_settlement::ID, accounts: metas, data: instruction::SettleTournament { payouts }.data() };
    env.send(ixs, auth, &[])
}

fn refund_entry(env: &mut Env, t: &Pubkey, player: &Keypair) -> Result<(), InstructionError> {
    let ixs = ix(
        accounts::RefundEntry { player: player.pubkey(), tournament: *t, entry: entry_pda(t, &player.pubkey()) },
        instruction::RefundEntry {},
    );
    env.send(ixs, player, &[])
}

#[test]
fn tournament_settlement_caps_the_house_fee() {
    let mut env = Env::new();
    env.initialize();
    let admin = env.admin.insecure_clone();
    let stranger = env.funded();
    let fee = SOL;

    assert_eq!(create_tournament(&mut env, &stranger, 1, fee, 4), Err(code(SettlementError::Unauthorized)));
    assert_eq!(create_tournament(&mut env, &admin, 1, fee, 1), Err(code(SettlementError::InvalidAmount)));
    let t = create_tournament(&mut env, &admin, 1, fee, 2).unwrap();

    let (a, b, c) = (env.funded(), env.funded(), env.funded());
    join(&mut env, &t, &a).unwrap();
    assert!(join(&mut env, &t, &a).is_err(), "one entry per player");
    join(&mut env, &t, &b).unwrap();
    assert_eq!(join(&mut env, &t, &c), Err(code(SettlementError::TournamentFull)));
    let tour: Tournament = env.account(&t);
    assert_eq!((tour.players, tour.pot), (2, 2 * fee));

    // Entries can't be refunded while the tournament is open.
    assert_eq!(refund_entry(&mut env, &t, &a), Err(code(SettlementError::TournamentClosed)));

    let treasury = Keypair::new().pubkey();
    let (w1, w2) = (Keypair::new().pubkey(), Keypair::new().pubkey());
    let pot = 2 * fee;
    let max_fee = pot * u64::from(FEE_BPS) / 10_000; // 0.1 SOL
    assert_eq!(settle(&mut env, &stranger, &t, &treasury, &[w1], vec![pot]), Err(code(SettlementError::Unauthorized)));
    assert_eq!(settle(&mut env, &admin, &t, &treasury, &[w1], vec![pot + 1]), Err(code(SettlementError::PayoutExceedsPot)));
    assert_eq!(settle(&mut env, &admin, &t, &treasury, &[w1], vec![pot - max_fee - 1]), Err(code(SettlementError::FeeTooHigh)));
    assert_eq!(settle(&mut env, &admin, &t, &treasury, &[w1, w2], vec![pot]), Err(code(SettlementError::InvalidWinners)));
    assert_eq!(settle(&mut env, &admin, &t, &treasury, &[], vec![]), Err(code(SettlementError::InvalidWinners)));

    let (p1, p2) = (pot / 2, pot / 2 - max_fee);
    settle(&mut env, &admin, &t, &treasury, &[w1, w2], vec![p1, p2]).unwrap();
    assert_eq!((env.balance(&w1), env.balance(&w2), env.balance(&treasury)), (p1, p2, max_fee));
    let tour: Tournament = env.account(&t);
    assert_eq!((tour.state, tour.pot), (TournamentState::Settled as u8, 0));
    assert_eq!(settle(&mut env, &admin, &t, &treasury, &[w1], vec![0]), Err(code(SettlementError::TournamentClosed)));

    // After settlement an entrant only gets the entry account's rent back, not the fee.
    let entry = entry_pda(&t, &a.pubkey());
    let rent = env.balance(&entry);
    let before = env.balance(&a.pubkey());
    refund_entry(&mut env, &t, &a).unwrap();
    assert_eq!(env.balance(&a.pubkey()), before + rent - 5_000); // minus the tx fee
    assert!(!env.exists(&entry));
}

#[test]
fn cancelled_tournament_refunds_entry_fees() {
    let mut env = Env::new();
    env.initialize();
    let admin = env.admin.insecure_clone();
    let fee = SOL / 10;
    let t = create_tournament(&mut env, &admin, 7, fee, 8).unwrap();
    let a = env.funded();
    join(&mut env, &t, &a).unwrap();

    let cancel = |auth: &Pubkey| ix(accounts::AdminTournament { authority: *auth, config: config_pda(), tournament: t }, instruction::CancelTournament {});
    assert_eq!(env.send(cancel(&a.pubkey()), &a, &[]), Err(code(SettlementError::Unauthorized)));
    env.send(cancel(&admin.pubkey()), &admin, &[]).unwrap();
    assert_eq!(env.account::<Tournament>(&t).state, TournamentState::Cancelled as u8);
    assert_eq!(env.send(cancel(&admin.pubkey()), &admin, &[]), Err(code(SettlementError::TournamentClosed)));
    let b = env.funded();
    assert_eq!(join(&mut env, &t, &b), Err(code(SettlementError::TournamentClosed)));

    let entry = entry_pda(&t, &a.pubkey());
    let rent = env.balance(&entry);
    let before = env.balance(&a.pubkey());
    refund_entry(&mut env, &t, &a).unwrap();
    assert_eq!(env.balance(&a.pubkey()), before + fee + rent - 5_000);
    assert_eq!(env.account::<Tournament>(&t).pot, 0);
    assert!(!env.exists(&entry));
}
