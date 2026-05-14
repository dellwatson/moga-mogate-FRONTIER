use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions::{
    load_current_index_checked, load_instruction_at_checked, ID as INSTRUCTIONS_ID,
};
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::{invoke, invoke_signed},
};
use anchor_spl::token::{self, spl_token::instruction::AuthorityType, Burn, FreezeAccount, Mint, ThawAccount, Token, TokenAccount};
use anchor_spl::associated_token::AssociatedToken;
use std::convert::TryInto;

declare_id!("7QLZYHojQdUAjfTMMzsa7zDADsJHFDYho1DJqttaL57x");

// Encrypt program ID (Encrypt pre-alpha on devnet)
pub const ENCRYPT_PRE_ALPHA_PROGRAM_ID: Pubkey =
    pubkey!("4ebfzWdKnrnGseuQpezXdG8yCdHqwQ1SSBHD3bWArND8");

// Authorization domain constants
const INIT_AUTH_DOMAIN: &[u8] = b"MOGATE_INIT";
const CLEANUP_AUTH_DOMAIN: &[u8] = b"MOGATE_CLEANUP";
const BURN_AUTH_DOMAIN: &[u8] = b"MOGATE_BURN";
const BATCH_BURN_AUTH_DOMAIN: &[u8] = b"MOGATE_BATCH_BURN";
const CHECKOUT_AUTH_DOMAIN: &[u8] = b"MOGATE_CHECKOUT";

// Encrypt CPI authority seed (must match Encrypt integration expectations)
const ENCRYPT_CPI_AUTHORITY_SEED: &[u8] = b"__encrypt_cpi_authority";

// Ed25519 signature constants
const SIGNATURE_LEN: usize = 64;
const PUBKEY_LEN: usize = 32;
const CURRENT_INSTRUCTION: u16 = 0;
const OFFSETS_START: usize = 2;

#[program]
pub mod mogate_giftcard {
    use super::*;

    /// Initializes the collection-level configuration PDA.
    ///
    /// The config owner is the administrative authority. The backend authority
    /// is the signer whose Ed25519 approvals authorize production init/burn.
    /// The gateway authority is the contract that can call gateway_mint_giftcard.
    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        backend_authority: Pubkey,
        gateway_authority: Pubkey,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.owner = ctx.accounts.owner.key();
        config.backend_authority = backend_authority;
        config.gateway_authority = gateway_authority;
        config.encrypt_program = ENCRYPT_PRE_ALPHA_PROGRAM_ID;
        config.arcium_program = Pubkey::default();
        Ok(())
    }

    /// Updates the backend signing wallet used for production authorizations.
    ///
    /// `owner` manages configuration; `backend_authority` signs approved
    /// merchant/backend actions such as mint registration and redeemed burns.
    pub fn set_backend_authority(
        ctx: Context<SetBackendAuthority>,
        backend_authority: Pubkey,
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.authority.key(),
            ctx.accounts.config.owner,
            GiftcardError::Unauthorized
        );
        ctx.accounts.config.backend_authority = backend_authority;
        Ok(())
    }

    /// Updates the external confidential-compute program ids used by CPI hooks.
    ///
    /// `encrypt_program` is the Encrypt protocol program. `arcium_program` is
    /// your Arcium MXE/confidential-compute program for this deployment.
    pub fn set_confidential_programs(
        ctx: Context<SetConfidentialPrograms>,
        encrypt_program: Pubkey,
        arcium_program: Pubkey,
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.authority.key(),
            ctx.accounts.config.owner,
            GiftcardError::Unauthorized
        );
        ctx.accounts.config.encrypt_program = encrypt_program;
        ctx.accounts.config.arcium_program = arcium_program;
        Ok(())
    }

    /// Public unsafe checkout (dev-only). No backend signature required.
    ///
    /// This mints a giftcard and initializes it atomically without any
    /// signature verification. Use for local/devnet testing only.
    pub fn unsafe_checkout(
        ctx: Context<CheckoutGiftcard>,
        recipient: Pubkey,
        metadata_uri: String,
        name: String,
        symbol: String,
        collection_mint: Pubkey,
        cipher_ref: String,
        backend: u8,
        key_handle: Vec<u8>,
    ) -> Result<()> {
        mint_and_initialize_giftcard_impl(
            ctx,
            recipient,
            metadata_uri,
            name,
            symbol,
            collection_mint,
            cipher_ref,
            backend,
            key_handle,
        )
    }

    /// Public safe checkout. Requires a valid backend signature.
    ///
    /// Callers must include a prior Ed25519 verification instruction
    /// signed by `config.backend_authority`. The signed message binds:
    /// - recipient, metadata_uri, name, symbol, collection_mint
    /// - cipher_ref, backend, key_handle
    /// - this program and config.
    pub fn checkout(
        ctx: Context<CheckoutGiftcard>,
        recipient: Pubkey,
        metadata_uri: String,
        name: String,
        symbol: String,
        collection_mint: Pubkey,
        cipher_ref: String,
        backend: u8,
        key_handle: Vec<u8>,
    ) -> Result<()> {
        // Verify backend signature
        let auth_message = build_checkout_message(
            ctx.program_id,
            ctx.accounts.config.key(),
            &recipient,
            &metadata_uri,
            &name,
            &symbol,
            &collection_mint,
            backend,
            &cipher_ref,
            &key_handle,
        )?;
        require_backend_signature(
            &ctx.accounts.instructions.to_account_info(),
            &ctx.accounts.config.backend_authority,
            &auth_message,
        )?;

        mint_and_initialize_giftcard_impl(
            ctx,
            recipient,
            metadata_uri,
            name,
            symbol,
            collection_mint,
            cipher_ref,
            backend,
            key_handle,
        )
    }

    /// Internal helper: mint 1 token, revoke mint authority, and initialize giftcard state.
    ///
    /// This function assumes all necessary checks (including backend signature)
    /// have already been performed by the calling public instruction.
    pub(crate) fn mint_and_initialize_giftcard_impl(
        ctx: Context<CheckoutGiftcard>,
        _recipient: Pubkey,
        _metadata_uri: String,
        _name: String,
        _symbol: String,
        _collection_mint: Pubkey,
        cipher_ref: String,
        backend: u8,
        key_handle: Vec<u8>,
    ) -> Result<()> {
        require!(
            backend <= Backend::Arcium as u8,
            GiftcardError::InvalidBackend
        );

        let mint = &ctx.accounts.mint;
        let payer = &ctx.accounts.payer;

        // Mint 1 token to the owner's token account
        let cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            token::MintTo {
                mint: mint.to_account_info(),
                to: ctx.accounts.token_account.to_account_info(),
                authority: payer.to_account_info(),
            },
        );
        token::mint_to(cpi_ctx, 1)?;

        // Revoke mint authority (make supply fixed)
        let cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            token::SetAuthority {
                account_or_mint: mint.to_account_info(),
                current_authority: payer.to_account_info(),
            },
        );
        token::set_authority(cpi_ctx, AuthorityType::MintTokens, None)?;

        // Initialize giftcard state (same checks as initialize_giftcard)
        initialize_giftcard_state(
            &mut ctx.accounts.giftcard,
            &ctx.accounts.config,
            &ctx.accounts.mint,
            &ctx.accounts.freeze_authority,
            payer.key(),
            cipher_ref.clone(),
            backend,
            key_handle.clone(),
        )?;

        Ok(())
    }

    
    
    /// Registers an already minted NFT as a Mogate giftcard.
    ///
    /// The SPL mint must have its freeze authority set to this program's
    /// `freeze_authority` PDA before registration. This lets `unwrap` freeze
    /// the holder's token account and make the giftcard soulbound.
    ///
    /// Production callers must include a prior Ed25519 verification instruction
    /// signed by `config.backend_authority`. The signed message binds the mint,
    /// backend, ciphertext reference, and encrypted handle to this program and config.
    pub fn initialize_giftcard(
        ctx: Context<InitializeGiftcard>,
        cipher_ref: String,
        backend: u8,
        key_handle: Vec<u8>,
    ) -> Result<()> {
        require!(
            backend <= Backend::Arcium as u8,
            GiftcardError::InvalidBackend
        );
        let auth_message = build_initialize_message(
            ctx.program_id,
            ctx.accounts.config.key(),
            ctx.accounts.mint.key(),
            backend,
            &cipher_ref,
            &key_handle,
        )?;
        require_backend_signature(
            &ctx.accounts.instructions.to_account_info(),
            &ctx.accounts.config.backend_authority,
            &auth_message,
        )?;
        initialize_giftcard_state(
            &mut ctx.accounts.giftcard,
            &ctx.accounts.config,
            &ctx.accounts.mint,
            &ctx.accounts.freeze_authority,
            ctx.accounts.authority.key(),
            cipher_ref,
            backend,
            key_handle,
        )?;

        Ok(())
    }

    /// Demo-only giftcard registration without backend signature checks.
    ///
    /// This is useful for local demos where no backend signer is available.
    /// Do not expose this path in production clients.
    pub fn unsafe_initialize_giftcard(
        ctx: Context<UnsafeInitializeGiftcard>,
        cipher_ref: String,
        backend: u8,
        key_handle: Vec<u8>,
    ) -> Result<()> {
        require!(
            backend <= Backend::Arcium as u8,
            GiftcardError::InvalidBackend
        );
        initialize_giftcard_state(
            &mut ctx.accounts.giftcard,
            &ctx.accounts.config,
            &ctx.accounts.mint,
            &ctx.accounts.freeze_authority,
            ctx.accounts.authority.key(),
            cipher_ref,
            backend,
            key_handle,
        )?;
        Ok(())
    }

    /// Redeems the NFT into a soulbound giftcard and grants decrypt permission.
    ///
    /// This is the Solana-side equivalent of `FHE.allow`: it records a
    /// `DecryptPermission` PDA for the current holder. Off-chain Encrypt or
    /// Arcium clients must verify this PDA before revealing the giftcode.
    pub fn unwrap(ctx: Context<Unwrap>) -> Result<()> {
        let giftcard = &mut ctx.accounts.giftcard;
        require!(!giftcard.unwrapped, GiftcardError::AlreadyUnwrapped);
        require!(
            ctx.accounts.owner_token_account.owner == ctx.accounts.owner.key(),
            GiftcardError::NotOwner
        );
        require!(
            ctx.accounts.owner_token_account.mint == giftcard.mint,
            GiftcardError::NotOwner
        );
        require!(
            ctx.accounts.owner_token_account.amount == 1,
            GiftcardError::NotOwner
        );
        require!(
            ctx.accounts.mint.freeze_authority == Some(ctx.accounts.freeze_authority.key()).into(),
            GiftcardError::FreezeAuthorityMismatch
        );

        giftcard.unwrapped = true;
        giftcard.redeemer = ctx.accounts.owner.key();
        giftcard.unwrapped_at = Clock::get()?.unix_timestamp;

        let permission = &mut ctx.accounts.decrypt_permission;
        permission.giftcard = giftcard.key();
        permission.mint = giftcard.mint;
        permission.grantee = ctx.accounts.owner.key();
        permission.backend = giftcard.backend;
        permission.allowed = true;
        permission.granted_at = giftcard.unwrapped_at;

        freeze_token_account(
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.owner_token_account.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.freeze_authority.to_account_info(),
            ctx.bumps.freeze_authority,
        )?;

        emit!(DecryptPermissionGranted {
            giftcard: giftcard.key(),
            mint: giftcard.mint,
            grantee: ctx.accounts.owner.key(),
            backend: giftcard.backend,
        });

        Ok(())
    }

    /// Batch version of `unwrap`.
    ///
    /// Remaining accounts must be supplied in repeated groups:
    /// `[giftcard, mint, owner_token_account, decrypt_permission]`.
    pub fn batch_unwrap<'info>(
        ctx: Context<'_, '_, 'info, 'info, BatchUnwrap<'info>>,
    ) -> Result<()> {
        require!(
            ctx.remaining_accounts.len() % 4 == 0,
            GiftcardError::InvalidRemainingAccounts
        );

        let clock = Clock::get()?;
        let freeze_bump = ctx.bumps.freeze_authority;

        for accounts in ctx.remaining_accounts.chunks(4) {
            let giftcard_info = &accounts[0];
            let mint_info = &accounts[1];
            let owner_token_account_info = &accounts[2];
            let permission_info = &accounts[3];

            let mut giftcard = Account::<Giftcard>::try_from(giftcard_info)?;
            let mint = Account::<Mint>::try_from(mint_info)?;
            let token_account = Account::<TokenAccount>::try_from(owner_token_account_info)?;
            let mut permission = Account::<DecryptPermission>::try_from(permission_info)?;

            require_keys_eq!(
                giftcard.config,
                ctx.accounts.config.key(),
                GiftcardError::InvalidConfig
            );
            require!(!giftcard.unwrapped, GiftcardError::AlreadyUnwrapped);
            require_keys_eq!(giftcard.mint, mint.key(), GiftcardError::InvalidMint);
            require_keys_eq!(
                token_account.owner,
                ctx.accounts.owner.key(),
                GiftcardError::NotOwner
            );
            require_keys_eq!(token_account.mint, giftcard.mint, GiftcardError::NotOwner);
            require!(token_account.amount == 1, GiftcardError::NotOwner);
            require!(
                mint.freeze_authority == Some(ctx.accounts.freeze_authority.key()).into(),
                GiftcardError::FreezeAuthorityMismatch
            );

            let expected_permission = Pubkey::find_program_address(
                &[
                    b"decrypt_permission",
                    giftcard_info.key.as_ref(),
                    ctx.accounts.owner.key.as_ref(),
                ],
                ctx.program_id,
            )
            .0;
            require_keys_eq!(
                permission_info.key(),
                expected_permission,
                GiftcardError::InvalidPermission
            );

            giftcard.unwrapped = true;
            giftcard.redeemer = ctx.accounts.owner.key();
            giftcard.unwrapped_at = clock.unix_timestamp;

            permission.giftcard = giftcard.key();
            permission.mint = giftcard.mint;
            permission.grantee = ctx.accounts.owner.key();
            permission.backend = giftcard.backend;
            permission.allowed = true;
            permission.granted_at = clock.unix_timestamp;

            freeze_token_account(
                ctx.accounts.token_program.to_account_info(),
                owner_token_account_info.to_account_info(),
                mint_info.to_account_info(),
                ctx.accounts.freeze_authority.to_account_info(),
                freeze_bump,
            )?;

            giftcard.exit(ctx.program_id)?;
            permission.exit(ctx.program_id)?;

            emit!(DecryptPermissionGranted {
                giftcard: giftcard_info.key(),
                mint: giftcard.mint,
                grantee: ctx.accounts.owner.key(),
                backend: giftcard.backend,
            });
        }

        Ok(())
    }

    /// Clears encrypted giftcard material after merchant-side consumption.
    ///
    /// This leaves the frozen soulbound NFT in place as a redeemed marker.
    /// Use this when the backend should invalidate the code but should not,
    /// or cannot, burn the holder's token.
    pub fn backend_cleanup(ctx: Context<BackendCleanup>) -> Result<()> {
        let auth_message = build_cleanup_message(
            ctx.program_id,
            ctx.accounts.config.key(),
            ctx.accounts.giftcard.key(),
            ctx.accounts.giftcard.mint,
        )?;
        require_backend_signature(
            &ctx.accounts.instructions.to_account_info(),
            &ctx.accounts.config.backend_authority,
            &auth_message,
        )?;
        cleanup_giftcard(&mut ctx.accounts.giftcard)?;
        Ok(())
    }

    /// Demo-only cleanup without backend signature verification.
    ///
    /// This clears encrypted material but does not burn the NFT. Keep it for
    /// local/devnet demos only.
    pub fn unsafe_backend_cleanup(ctx: Context<UnsafeBackendCleanup>) -> Result<()> {
        cleanup_giftcard(&mut ctx.accounts.giftcard)?;
        Ok(())
    }

    /// Batch burn for redeemed giftcards.
    ///
    /// Remaining accounts must be supplied in repeated groups:
    /// `[giftcard, mint, owner_token_account, token_owner]`.
    ///
    /// A prior backend Ed25519 authorization signs the exact account batch.
    /// Each `token_owner` must still sign so SPL Token accepts the token burn.
    pub fn batch_burn<'info>(ctx: Context<'_, '_, 'info, 'info, BatchBurn<'info>>) -> Result<()> {
        let auth_message = build_batch_burn_message(
            ctx.program_id,
            ctx.accounts.config.key(),
            ctx.remaining_accounts,
        )?;
        require_backend_signature(
            &ctx.accounts.instructions.to_account_info(),
            &ctx.accounts.config.backend_authority,
            &auth_message,
        )?;
        batch_burn_redeemed(ctx)
    }

    /// Demo-only batch burn without backend signature checks.
    ///
    /// This has the same SPL Token signer requirements as `batch_burn`, but
    /// skips merchant authorization for demos.
    pub fn unsafe_batch_burn<'info>(
        ctx: Context<'_, '_, 'info, 'info, BatchBurn<'info>>,
    ) -> Result<()> {
        batch_burn_redeemed(ctx)
    }

    /// Burns a redeemed giftcard NFT and clears its encrypted material.
    ///
    /// Call this after the holder has unwrapped the giftcard and the merchant
    /// backend has confirmed the off-chain giftcode was consumed. A prior
    /// Ed25519 instruction signed by `config.backend_authority` authorizes the
    /// cleanup decision, while `token_owner` authorizes the SPL Token burn.
    pub fn burn_redeemed(ctx: Context<BurnRedeemed>) -> Result<()> {
        let auth_message = build_burn_message(
            ctx.program_id,
            ctx.accounts.config.key(),
            ctx.accounts.giftcard.key(),
            ctx.accounts.mint.key(),
            ctx.accounts.token_owner.key(),
        )?;
        require_backend_signature(
            &ctx.accounts.instructions.to_account_info(),
            &ctx.accounts.config.backend_authority,
            &auth_message,
        )?;
        burn_redeemed_token(ctx)
    }

    /// Demo-only redeemed burn without backend signature checks.
    ///
    /// The token owner must still sign. This bypasses only the merchant
    /// authorization guard for local testing.
    pub fn unsafe_burn_redeemed(ctx: Context<BurnRedeemed>) -> Result<()> {
        burn_redeemed_token(ctx)
    }

    /// Calls the configured Encrypt/Arcium program after Mogate unwrap approval.
    ///
    /// The caller supplies the serialized CPI instruction data and all remaining
    /// accounts expected by the external protocol. This program verifies that
    /// the giftcard is unwrapped, the `DecryptPermission` PDA grants the signer
    /// access, and the CPI target matches the giftcard backend.
    pub fn grant_confidential_permission_cpi<'info>(
        ctx: Context<'_, '_, 'info, 'info, GrantConfidentialPermissionCpi<'info>>,
        cpi_data: Vec<u8>,
    ) -> Result<()> {
        grant_confidential_permission(ctx, cpi_data, None)
    }

    /// Copies the program-authorized Encrypt ciphertext to a grantee-authorized ciphertext.
    ///
    /// This is the real Encrypt access-control path for unwrapped giftcards.
    /// Encrypt pre-alpha does not use `FHE.allow` guard accounts; its ciphertext
    /// account has an `authorized` field. Keeping the source ciphertext
    /// authorized to this program and copying it to `grantee` gives the holder
    /// decrypt/use access without giving up backend cleanup control.
    pub fn encrypt_copy_giftcode_for_grantee(
        ctx: Context<EncryptCopyGiftcodeForGrantee>,
    ) -> Result<()> {
        encrypt_copy_giftcode_for_grantee_impl(ctx, None)
    }
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init,
        payer = owner,
        space = 8 + Config::MAX_SIZE,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetBackendAuthority<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct SetConfidentialPrograms<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct MintAndInitializeGiftcard<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub token_owner: SystemAccount<'info>,
    #[account(
        init,
        payer = payer,
        mint::decimals = 0,
        mint::authority = payer,
        mint::freeze_authority = freeze_authority,
    )]
    pub mint: Account<'info, Mint>,
    #[account(
        init,
        payer = payer,
        token::mint = mint,
        token::authority = token_owner,
    )]
    pub token_account: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = payer,
        space = 8 + Giftcard::MAX_SIZE,
        seeds = [b"giftcard", mint.key().as_ref()],
        bump
    )]
    pub giftcard: Account<'info, Giftcard>,
    #[account(seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    /// CHECK: PDA used only as a program signer for SPL Token freeze authority.
    #[account(
        seeds = [b"freeze_authority"],
        bump
    )]
    pub freeze_authority: UncheckedAccount<'info>,
    /// CHECK: Metaplex Token Metadata program.
    pub metadata_program: UncheckedAccount<'info>,
    /// CHECK: Solana instructions sysvar used for backend signature verification.
    #[account(address = INSTRUCTIONS_ID)]
    pub instructions: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct CheckoutGiftcard<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub token_owner: SystemAccount<'info>,
    #[account(
        init,
        payer = payer,
        mint::decimals = 0,
        mint::authority = payer,
        mint::freeze_authority = freeze_authority,
    )]
    pub mint: Account<'info, Mint>,
    #[account(
        init,
        payer = payer,
        token::mint = mint,
        token::authority = token_owner,
    )]
    pub token_account: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = payer,
        space = 8 + Giftcard::MAX_SIZE,
        seeds = [b"giftcard", mint.key().as_ref()],
        bump
    )]
    pub giftcard: Account<'info, Giftcard>,
    #[account(seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    /// CHECK: PDA used only as a program signer for SPL Token freeze authority.
    #[account(
        seeds = [b"freeze_authority"],
        bump
    )]
    pub freeze_authority: UncheckedAccount<'info>,
    /// CHECK: Metaplex Token Metadata program.
    pub metadata_program: UncheckedAccount<'info>,
    /// CHECK: Solana instructions sysvar used for backend signature verification.
    #[account(address = INSTRUCTIONS_ID)]
    pub instructions: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct GatewayMintGiftcard<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub token_owner: SystemAccount<'info>,
    #[account(
        init,
        payer = payer,
        mint::decimals = 0,
        mint::authority = payer,
        mint::freeze_authority = freeze_authority,
    )]
    pub mint: Account<'info, Mint>,
    #[account(
        init,
        payer = payer,
        token::mint = mint,
        token::authority = token_owner,
    )]
    pub token_account: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = payer,
        space = 8 + Giftcard::MAX_SIZE,
        seeds = [b"giftcard", mint.key().as_ref()],
        bump
    )]
    pub giftcard: Account<'info, Giftcard>,
    #[account(seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    /// CHECK: PDA used only as a program signer for SPL Token freeze authority.
    #[account(
        seeds = [b"freeze_authority"],
        bump
    )]
    pub freeze_authority: UncheckedAccount<'info>,
    /// CHECK: Metaplex Token Metadata program.
    pub metadata_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct SetGatewayAuthority<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct InitializeGiftcard<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    pub mint: Account<'info, Mint>,
    #[account(
        init,
        payer = authority,
        space = 8 + Giftcard::MAX_SIZE,
        seeds = [b"giftcard", mint.key().as_ref()],
        bump
    )]
    pub giftcard: Account<'info, Giftcard>,
    /// CHECK: PDA used only as a program signer for SPL Token freeze authority.
    #[account(
        seeds = [b"freeze_authority"],
        bump
    )]
    pub freeze_authority: UncheckedAccount<'info>,
    /// CHECK: Solana instructions sysvar used to inspect the backend Ed25519 verification instruction.
    #[account(address = INSTRUCTIONS_ID)]
    pub instructions: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UnsafeInitializeGiftcard<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    pub mint: Account<'info, Mint>,
    #[account(
        init,
        payer = authority,
        space = 8 + Giftcard::MAX_SIZE,
        seeds = [b"giftcard", mint.key().as_ref()],
        bump
    )]
    pub giftcard: Account<'info, Giftcard>,
    /// CHECK: PDA used only as a program signer for SPL Token freeze authority.
    #[account(
        seeds = [b"freeze_authority"],
        bump
    )]
    pub freeze_authority: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Unwrap<'info> {
    #[account(mut, has_one = mint, has_one = config)]
    pub giftcard: Account<'info, Giftcard>,
    #[account(seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    pub mint: Account<'info, Mint>,
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        constraint = owner_token_account.owner == owner.key(),
        constraint = owner_token_account.mint == mint.key()
    )]
    pub owner_token_account: Account<'info, TokenAccount>,
    #[account(
        seeds = [b"freeze_authority"],
        bump
    )]
    /// CHECK: PDA used only as a program signer for SPL Token freeze authority.
    pub freeze_authority: UncheckedAccount<'info>,
    #[account(
        init,
        payer = owner,
        space = 8 + DecryptPermission::MAX_SIZE,
        seeds = [b"decrypt_permission", giftcard.key().as_ref(), owner.key().as_ref()],
        bump
    )]
    pub decrypt_permission: Account<'info, DecryptPermission>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct BatchUnwrap<'info> {
    #[account(seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        seeds = [b"freeze_authority"],
        bump
    )]
    /// CHECK: PDA used only as a program signer for SPL Token freeze authority.
    pub freeze_authority: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct BackendCleanup<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(mut, has_one = config)]
    pub giftcard: Account<'info, Giftcard>,
    /// CHECK: Solana instructions sysvar used by the signed cleanup path.
    #[account(address = INSTRUCTIONS_ID)]
    pub instructions: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct UnsafeBackendCleanup<'info> {
    #[account(mut, has_one = config)]
    pub giftcard: Account<'info, Giftcard>,
    #[account(seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct BatchBurn<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(
        seeds = [b"freeze_authority"],
        bump
    )]
    /// CHECK: PDA used only as a program signer for SPL Token freeze authority.
    pub freeze_authority: UncheckedAccount<'info>,
    /// CHECK: Solana instructions sysvar used by the signed burn path.
    #[account(address = INSTRUCTIONS_ID)]
    pub instructions: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct BurnRedeemed<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    pub token_owner: Signer<'info>,
    #[account(seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(mut, has_one = config, has_one = mint)]
    pub giftcard: Account<'info, Giftcard>,
    #[account(mut)]
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        constraint = owner_token_account.owner == token_owner.key(),
        constraint = owner_token_account.mint == mint.key()
    )]
    pub owner_token_account: Account<'info, TokenAccount>,
    #[account(
        seeds = [b"freeze_authority"],
        bump
    )]
    /// CHECK: PDA used only as a program signer for SPL Token freeze authority.
    pub freeze_authority: UncheckedAccount<'info>,
    /// CHECK: Solana instructions sysvar used by the signed burn path.
    #[account(address = INSTRUCTIONS_ID)]
    pub instructions: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct GrantConfidentialPermissionCpi<'info> {
    pub grantee: Signer<'info>,
    #[account(seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(has_one = config)]
    pub giftcard: Account<'info, Giftcard>,
    #[account(
        seeds = [b"decrypt_permission", giftcard.key().as_ref(), grantee.key().as_ref()],
        bump
    )]
    pub decrypt_permission: Account<'info, DecryptPermission>,
    /// CHECK: Checked against Config.encrypt_program or Config.arcium_program,
    /// then passed as the invoked confidential-compute program account.
    #[account(constraint = confidential_program.executable @ GiftcardError::InvalidConfidentialProgram)]
    pub confidential_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct EncryptCopyGiftcodeForGrantee<'info> {
    pub grantee: Signer<'info>,
    #[account(seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(has_one = config)]
    pub giftcard: Account<'info, Giftcard>,
    #[account(
        seeds = [b"decrypt_permission", giftcard.key().as_ref(), grantee.key().as_ref()],
        bump
    )]
    pub decrypt_permission: Account<'info, DecryptPermission>,
    /// CHECK: Encrypt ciphertext account referenced by Giftcard.key_handle.
    pub source_ciphertext: UncheckedAccount<'info>,
    /// Empty Encrypt ciphertext account keypair created by the Encrypt program.
    ///
    /// The Encrypt copy instruction allocates this account, so the keypair must
    /// sign the outer transaction and be forwarded as a signer in the CPI.
    #[account(mut)]
    pub grantee_ciphertext: Signer<'info>,
    /// CHECK: Must match Config.encrypt_program and be executable.
    #[account(
        constraint = encrypt_program.key() == config.encrypt_program @ GiftcardError::InvalidConfidentialProgram,
        constraint = encrypt_program.executable @ GiftcardError::InvalidConfidentialProgram
    )]
    pub encrypt_program: UncheckedAccount<'info>,
    /// CHECK: Encrypt protocol config account.
    pub encrypt_config: UncheckedAccount<'info>,
    /// CHECK: Encrypt protocol deposit account.
    #[account(mut)]
    pub deposit: UncheckedAccount<'info>,
    /// CHECK: Encrypt CPI authority PDA for this Mogate program.
    #[account(seeds = [ENCRYPT_CPI_AUTHORITY_SEED], bump)]
    pub cpi_authority: UncheckedAccount<'info>,
    /// CHECK: This program's executable account; used by Encrypt to derive program authorization.
    #[account(
        constraint = caller_program.key() == crate::ID @ GiftcardError::InvalidConfidentialProgram,
        constraint = caller_program.executable @ GiftcardError::InvalidConfidentialProgram
    )]
    pub caller_program: UncheckedAccount<'info>,
    /// CHECK: Encrypt network encryption key account.
    pub network_encryption_key: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: Encrypt event authority PDA.
    pub event_authority: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct Config {
    pub owner: Pubkey,
    pub backend_authority: Pubkey,
    pub gateway_authority: Pubkey,
    pub encrypt_program: Pubkey,
    pub arcium_program: Pubkey,
}

impl Config {
    pub const MAX_SIZE: usize = 32 + 32 + 32 + 32 + 32;
}

#[account]
pub struct DecryptPermission {
    pub giftcard: Pubkey,
    pub mint: Pubkey,
    pub grantee: Pubkey,
    pub backend: u8,
    pub allowed: bool,
    pub granted_at: i64,
}

impl DecryptPermission {
    pub const MAX_SIZE: usize = 32 + 32 + 32 + 1 + 1 + 8;
}

#[account]
pub struct Giftcard {
    pub config: Pubkey,
    pub mint: Pubkey,
    pub cipher_ref: String,
    pub key_handle: Vec<u8>,
    pub backend: u8,
    pub unwrapped: bool,
    pub consumed: bool,
    pub authority: Pubkey,
    pub redeemer: Pubkey,
    pub unwrapped_at: i64,
}

impl Giftcard {
    pub const MAX_CIPHER_REF_LEN: usize = 256;
    pub const MAX_KEY_HANDLE_LEN: usize = 256;
    pub const MAX_SIZE: usize = 32
        + 32
        + 4
        + Self::MAX_CIPHER_REF_LEN
        + 4
        + Self::MAX_KEY_HANDLE_LEN
        + 1
        + 1
        + 1
        + 32
        + 32
        + 8;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    Encrypt = 0,
    Arcium = 1,
}

#[event]
pub struct DecryptPermissionGranted {
    pub giftcard: Pubkey,
    pub mint: Pubkey,
    pub grantee: Pubkey,
    pub backend: u8,
}

#[event]
pub struct GiftcardBurned {
    pub giftcard: Pubkey,
    pub mint: Pubkey,
    pub authority: Pubkey,
}

const ED25519_PROGRAM_ID: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");
const ENCRYPT_IX_COPY_CIPHERTEXT: u8 = 8;

fn initialize_giftcard_state<'info>(
    giftcard: &mut Account<'info, Giftcard>,
    config: &Account<'info, Config>,
    mint: &Account<'info, Mint>,
    freeze_authority: &UncheckedAccount<'info>,
    authority: Pubkey,
    cipher_ref: String,
    backend: u8,
    key_handle: Vec<u8>,
) -> Result<()> {
    require!(
        mint.freeze_authority == Some(freeze_authority.key()).into(),
        GiftcardError::FreezeAuthorityMismatch
    );
    require!(
        cipher_ref.as_bytes().len() <= Giftcard::MAX_CIPHER_REF_LEN,
        GiftcardError::CipherRefTooLong
    );
    require!(
        key_handle.len() <= Giftcard::MAX_KEY_HANDLE_LEN,
        GiftcardError::KeyHandleTooLong
    );

    giftcard.config = config.key();
    giftcard.mint = mint.key();
    giftcard.cipher_ref = cipher_ref;
    giftcard.key_handle = key_handle;
    giftcard.backend = backend;
    giftcard.unwrapped = false;
    giftcard.consumed = false;
    giftcard.authority = authority;
    giftcard.redeemer = Pubkey::default();
    giftcard.unwrapped_at = 0;
    Ok(())
}

fn build_initialize_message(
    program_id: &Pubkey,
    config: Pubkey,
    mint: Pubkey,
    backend: u8,
    cipher_ref: &str,
    key_handle: &[u8],
) -> Result<Vec<u8>> {
    let mut message = Vec::with_capacity(
        INIT_AUTH_DOMAIN.len() + 32 + 32 + 32 + 1 + 2 + cipher_ref.len() + 2 + key_handle.len(),
    );
    message.extend_from_slice(INIT_AUTH_DOMAIN);
    message.extend_from_slice(program_id.as_ref());
    message.extend_from_slice(config.as_ref());
    message.extend_from_slice(mint.as_ref());
    message.push(backend);
    append_auth_bytes(&mut message, cipher_ref.as_bytes())?;
    append_auth_bytes(&mut message, key_handle)?;
    Ok(message)
}

fn build_checkout_message(
    program_id: &Pubkey,
    config: Pubkey,
    recipient: &Pubkey,
    metadata_uri: &str,
    name: &str,
    symbol: &str,
    collection_mint: &Pubkey,
    backend: u8,
    cipher_ref: &str,
    key_handle: &[u8],
) -> Result<Vec<u8>> {
    let mut message = Vec::with_capacity(
        CHECKOUT_AUTH_DOMAIN.len() + 32 + 32 + 32 + 2 + metadata_uri.len() + 2 + name.len() + 2 + symbol.len() + 32 + 1 + 2 + cipher_ref.len() + 2 + key_handle.len(),
    );
    message.extend_from_slice(CHECKOUT_AUTH_DOMAIN);
    message.extend_from_slice(program_id.as_ref());
    message.extend_from_slice(config.as_ref());
    message.extend_from_slice(recipient.as_ref());
    append_auth_bytes(&mut message, metadata_uri.as_bytes())?;
    append_auth_bytes(&mut message, name.as_bytes())?;
    append_auth_bytes(&mut message, symbol.as_bytes())?;
    message.extend_from_slice(collection_mint.as_ref());
    message.push(backend);
    append_auth_bytes(&mut message, cipher_ref.as_bytes())?;
    append_auth_bytes(&mut message, key_handle)?;
    Ok(message)
}

fn build_cleanup_message(
    program_id: &Pubkey,
    config: Pubkey,
    giftcard: Pubkey,
    mint: Pubkey,
) -> Result<Vec<u8>> {
    let mut message = Vec::with_capacity(CLEANUP_AUTH_DOMAIN.len() + 32 + 32 + 32 + 32);
    message.extend_from_slice(CLEANUP_AUTH_DOMAIN);
    message.extend_from_slice(program_id.as_ref());
    message.extend_from_slice(config.as_ref());
    message.extend_from_slice(giftcard.as_ref());
    message.extend_from_slice(mint.as_ref());
    Ok(message)
}

fn build_burn_message(
    program_id: &Pubkey,
    config: Pubkey,
    giftcard: Pubkey,
    mint: Pubkey,
    token_owner: Pubkey,
) -> Result<Vec<u8>> {
    let mut message = Vec::with_capacity(151);
    message.extend_from_slice(BURN_AUTH_DOMAIN);
    message.extend_from_slice(program_id.as_ref());
    message.extend_from_slice(config.as_ref());
    message.extend_from_slice(giftcard.as_ref());
    message.extend_from_slice(mint.as_ref());
    message.extend_from_slice(token_owner.as_ref());
    Ok(message)
}

fn build_batch_burn_message<'info>(
    program_id: &Pubkey,
    config: Pubkey,
    remaining_accounts: &[AccountInfo<'info>],
) -> Result<Vec<u8>> {
    require!(
        remaining_accounts.len() % 4 == 0,
        GiftcardError::InvalidRemainingAccounts
    );

    let mut batch_accounts = Vec::with_capacity(remaining_accounts.len() * 32);
    for accounts in remaining_accounts.chunks(4) {
        batch_accounts.extend_from_slice(accounts[0].key.as_ref());
        batch_accounts.extend_from_slice(accounts[1].key.as_ref());
        batch_accounts.extend_from_slice(accounts[2].key.as_ref());
        batch_accounts.extend_from_slice(accounts[3].key.as_ref());
    }

    let mut message =
        Vec::with_capacity(BATCH_BURN_AUTH_DOMAIN.len() + 32 + 32 + 2 + batch_accounts.len());
    message.extend_from_slice(BATCH_BURN_AUTH_DOMAIN);
    message.extend_from_slice(program_id.as_ref());
    message.extend_from_slice(config.as_ref());
    append_auth_bytes(&mut message, &batch_accounts)?;
    Ok(message)
}

fn append_auth_bytes(message: &mut Vec<u8>, bytes: &[u8]) -> Result<()> {
    let len = u16::try_from(bytes.len())
        .map_err(|_| error!(GiftcardError::AuthorizationMessageTooLong))?;
    message.extend_from_slice(&len.to_le_bytes());
    message.extend_from_slice(bytes);
    Ok(())
}

fn require_backend_signature(
    instructions: &AccountInfo,
    signer: &Pubkey,
    message: &[u8],
) -> Result<()> {
    let current_index = load_current_index_checked(instructions)
        .map_err(|_| error!(GiftcardError::MissingBackendSignature))?;
    require!(current_index > 0, GiftcardError::MissingBackendSignature);

    for index in 0..current_index {
        let instruction = load_instruction_at_checked(index as usize, instructions)
            .map_err(|_| error!(GiftcardError::MissingBackendSignature))?;
        if instruction.program_id == ED25519_PROGRAM_ID
            && ed25519_instruction_matches(&instruction.data, signer.as_ref(), message)?
        {
            return Ok(());
        }
    }

    err!(GiftcardError::MissingBackendSignature)
}

fn ed25519_instruction_matches(
    data: &[u8],
    expected_pubkey: &[u8],
    expected_message: &[u8],
) -> Result<bool> {
    const OFFSETS_START: usize = 2;
    const OFFSETS_LEN: usize = 14;
    const SIGNATURE_LEN: usize = 64;
    const PUBKEY_LEN: usize = 32;
    const CURRENT_INSTRUCTION: u16 = u16::MAX;

    if data.len() < OFFSETS_START + OFFSETS_LEN || data[0] == 0 {
        return Ok(false);
    }

    let signature_offset = read_u16(data, OFFSETS_START)?;
    let signature_instruction_index = read_u16(data, OFFSETS_START + 2)?;
    let public_key_offset = read_u16(data, OFFSETS_START + 4)?;
    let public_key_instruction_index = read_u16(data, OFFSETS_START + 6)?;
    let message_data_offset = read_u16(data, OFFSETS_START + 8)?;
    let message_data_size = read_u16(data, OFFSETS_START + 10)?;
    let message_instruction_index = read_u16(data, OFFSETS_START + 12)?;

    // The scripts use the standard single-instruction Ed25519 layout where
    // pubkey, signature, and message all live inside the same native ix.
    if signature_instruction_index != CURRENT_INSTRUCTION
        || public_key_instruction_index != CURRENT_INSTRUCTION
        || message_instruction_index != CURRENT_INSTRUCTION
    {
        return Ok(false);
    }

    let signature_start = signature_offset as usize;
    let public_key_start = public_key_offset as usize;
    let message_start = message_data_offset as usize;
    let message_len = message_data_size as usize;
    let signature_end = signature_start
        .checked_add(SIGNATURE_LEN)
        .ok_or(GiftcardError::MissingBackendSignature)?;
    let public_key_end = public_key_start
        .checked_add(PUBKEY_LEN)
        .ok_or(GiftcardError::MissingBackendSignature)?;
    let message_end = message_start
        .checked_add(message_len)
        .ok_or(GiftcardError::MissingBackendSignature)?;

    if signature_end > data.len() || public_key_end > data.len() || message_end > data.len() {
        return Ok(false);
    }

    Ok(&data[public_key_start..public_key_end] == expected_pubkey
        && &data[message_start..message_end] == expected_message)
}

fn read_u16(data: &[u8], offset: usize) -> Result<u16> {
    let bytes = data
        .get(offset..offset + 2)
        .ok_or(GiftcardError::MissingBackendSignature)?;
    Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
}

fn burn_redeemed_token(ctx: Context<BurnRedeemed>) -> Result<()> {
    require!(ctx.accounts.giftcard.unwrapped, GiftcardError::NotUnwrapped);
    require_keys_eq!(
        ctx.accounts.owner_token_account.mint,
        ctx.accounts.giftcard.mint,
        GiftcardError::InvalidMint
    );

    thaw_token_account(
        ctx.accounts.token_program.to_account_info(),
        ctx.accounts.owner_token_account.to_account_info(),
        ctx.accounts.mint.to_account_info(),
        ctx.accounts.freeze_authority.to_account_info(),
        ctx.bumps.freeze_authority,
    )?;

    let cpi_ctx = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        Burn {
            mint: ctx.accounts.mint.to_account_info(),
            from: ctx.accounts.owner_token_account.to_account_info(),
            authority: ctx.accounts.token_owner.to_account_info(),
        },
    );
    token::burn(cpi_ctx, 1)?;

    cleanup_giftcard(&mut ctx.accounts.giftcard)?;
    emit!(GiftcardBurned {
        giftcard: ctx.accounts.giftcard.key(),
        mint: ctx.accounts.giftcard.mint,
        authority: ctx.accounts.authority.key(),
    });

    Ok(())
}

fn batch_burn_redeemed<'info>(ctx: Context<'_, '_, 'info, 'info, BatchBurn<'info>>) -> Result<()> {
    require!(
        ctx.remaining_accounts.len() % 4 == 0,
        GiftcardError::InvalidRemainingAccounts
    );

    for accounts in ctx.remaining_accounts.chunks(4) {
        let giftcard_info = &accounts[0];
        let mint_info = &accounts[1];
        let owner_token_account_info = &accounts[2];
        let token_owner_info = &accounts[3];

        require!(token_owner_info.is_signer, GiftcardError::Unauthorized);

        let mut giftcard = Account::<Giftcard>::try_from(giftcard_info)?;
        let mint = Account::<Mint>::try_from(mint_info)?;
        let owner_token_account = Account::<TokenAccount>::try_from(owner_token_account_info)?;

        require_keys_eq!(
            giftcard.config,
            ctx.accounts.config.key(),
            GiftcardError::InvalidConfig
        );
        require!(giftcard.unwrapped, GiftcardError::NotUnwrapped);
        require_keys_eq!(giftcard.mint, mint.key(), GiftcardError::InvalidMint);
        require_keys_eq!(
            owner_token_account.owner,
            token_owner_info.key(),
            GiftcardError::NotOwner
        );
        require_keys_eq!(
            owner_token_account.mint,
            giftcard.mint,
            GiftcardError::InvalidMint
        );

        thaw_token_account(
            ctx.accounts.token_program.to_account_info(),
            owner_token_account_info.to_account_info(),
            mint_info.to_account_info(),
            ctx.accounts.freeze_authority.to_account_info(),
            ctx.bumps.freeze_authority,
        )?;

        let cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: mint_info.to_account_info(),
                from: owner_token_account_info.to_account_info(),
                authority: token_owner_info.to_account_info(),
            },
        );
        token::burn(cpi_ctx, 1)?;

        cleanup_giftcard(&mut giftcard)?;
        giftcard.exit(ctx.program_id)?;
        emit!(GiftcardBurned {
            giftcard: giftcard_info.key(),
            mint: giftcard.mint,
            authority: ctx.accounts.authority.key(),
        });
    }

    Ok(())
}

fn grant_confidential_permission<'info>(
    ctx: Context<'_, '_, 'info, 'info, GrantConfidentialPermissionCpi<'info>>,
    cpi_data: Vec<u8>,
    required_backend: Option<u8>,
) -> Result<()> {
    let giftcard = &ctx.accounts.giftcard;
    let permission = &ctx.accounts.decrypt_permission;
    require!(giftcard.unwrapped, GiftcardError::NotUnwrapped);
    if let Some(backend) = required_backend {
        require!(giftcard.backend == backend, GiftcardError::InvalidBackend);
    }
    require!(permission.allowed, GiftcardError::Unauthorized);
    require_keys_eq!(
        permission.giftcard,
        giftcard.key(),
        GiftcardError::InvalidPermission
    );
    require_keys_eq!(
        permission.mint,
        giftcard.mint,
        GiftcardError::InvalidPermission
    );
    require_keys_eq!(
        permission.grantee,
        ctx.accounts.grantee.key(),
        GiftcardError::Unauthorized
    );
    require!(
        permission.backend == giftcard.backend,
        GiftcardError::InvalidBackend
    );

    let expected_program = match giftcard.backend {
        x if x == Backend::Encrypt as u8 => ctx.accounts.config.encrypt_program,
        x if x == Backend::Arcium as u8 => ctx.accounts.config.arcium_program,
        _ => return err!(GiftcardError::InvalidBackend),
    };
    require_keys_eq!(
        ctx.accounts.confidential_program.key(),
        expected_program,
        GiftcardError::InvalidConfidentialProgram
    );

    // Solana raw CPI requires the invoked program account in the AccountInfo
    // slice in addition to the accounts listed in the instruction metas.
    let mut account_infos = ctx.remaining_accounts.to_vec();
    account_infos.push(ctx.accounts.confidential_program.to_account_info());
    let account_metas = ctx
        .remaining_accounts
        .iter()
        .map(|account| {
            if account.is_writable {
                AccountMeta::new(*account.key, account.is_signer)
            } else {
                AccountMeta::new_readonly(*account.key, account.is_signer)
            }
        })
        .collect();

    let ix = Instruction {
        program_id: expected_program,
        accounts: account_metas,
        data: cpi_data,
    };
    invoke(&ix, &account_infos)?;
    Ok(())
}

fn encrypt_copy_giftcode_for_grantee_impl(
    ctx: Context<EncryptCopyGiftcodeForGrantee>,
    required_backend: Option<u8>,
) -> Result<()> {
    let giftcard = &ctx.accounts.giftcard;
    let permission = &ctx.accounts.decrypt_permission;
    let required_backend = required_backend.unwrap_or(Backend::Encrypt as u8);

    require!(giftcard.unwrapped, GiftcardError::NotUnwrapped);
    require!(giftcard.backend == required_backend, GiftcardError::InvalidBackend);
    require!(permission.allowed, GiftcardError::Unauthorized);
    require_keys_eq!(
        permission.giftcard,
        giftcard.key(),
        GiftcardError::InvalidPermission
    );
    require_keys_eq!(
        permission.mint,
        giftcard.mint,
        GiftcardError::InvalidPermission
    );
    require_keys_eq!(
        permission.grantee,
        ctx.accounts.grantee.key(),
        GiftcardError::Unauthorized
    );
    require!(
        permission.backend == Backend::Encrypt as u8,
        GiftcardError::InvalidBackend
    );
    require_keys_eq!(
        key_handle_pubkey(&giftcard.key_handle)?,
        ctx.accounts.source_ciphertext.key(),
        GiftcardError::InvalidCiphertext
    );

    let ix = Instruction {
        program_id: ctx.accounts.encrypt_program.key(),
        accounts: vec![
            AccountMeta::new_readonly(ctx.accounts.source_ciphertext.key(), false),
            AccountMeta::new(ctx.accounts.grantee_ciphertext.key(), true),
            AccountMeta::new_readonly(ctx.accounts.caller_program.key(), false),
            AccountMeta::new_readonly(ctx.accounts.cpi_authority.key(), true),
            AccountMeta::new_readonly(ctx.accounts.grantee.key(), false),
            AccountMeta::new(ctx.accounts.payer.key(), true),
            AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
        ],
        data: vec![ENCRYPT_IX_COPY_CIPHERTEXT],
    };
    let account_infos = vec![
        ctx.accounts.source_ciphertext.to_account_info(),
        ctx.accounts.grantee_ciphertext.to_account_info(),
        ctx.accounts.caller_program.to_account_info(),
        ctx.accounts.cpi_authority.to_account_info(),
        ctx.accounts.grantee.to_account_info(),
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.system_program.to_account_info(),
        ctx.accounts.encrypt_program.to_account_info(),
    ];
    let seeds: [&[u8]; 2] = [ENCRYPT_CPI_AUTHORITY_SEED, &[ctx.bumps.cpi_authority]];
    let signer_seeds: [&[&[u8]]; 1] = [&seeds];
    invoke_signed(&ix, &account_infos, &signer_seeds)?;
    Ok(())
}

fn key_handle_pubkey(key_handle: &[u8]) -> Result<Pubkey> {
    let ciphertext_identifier = match key_handle.len() {
        32 => key_handle,
        // Encrypt script handles are serialized as fhe_type(1) || ciphertext_identifier(32).
        33 => &key_handle[1..],
        _ => return err!(GiftcardError::InvalidCiphertext),
    };
    let bytes: [u8; 32] = ciphertext_identifier
        .try_into()
        .map_err(|_| error!(GiftcardError::InvalidCiphertext))?;
    Ok(Pubkey::new_from_array(bytes))
}

fn freeze_token_account<'info>(
    token_program: AccountInfo<'info>,
    token_account: AccountInfo<'info>,
    mint: AccountInfo<'info>,
    freeze_authority: AccountInfo<'info>,
    bump: u8,
) -> Result<()> {
    let seeds: [&[u8]; 2] = [b"freeze_authority", &[bump]];
    let signer_seeds: [&[&[u8]]; 1] = [&seeds];
    let cpi_ctx = CpiContext::new_with_signer(
        token_program,
        FreezeAccount {
            account: token_account,
            mint,
            authority: freeze_authority,
        },
        &signer_seeds,
    );
    token::freeze_account(cpi_ctx)
}

fn thaw_token_account<'info>(
    token_program: AccountInfo<'info>,
    token_account: AccountInfo<'info>,
    mint: AccountInfo<'info>,
    freeze_authority: AccountInfo<'info>,
    bump: u8,
) -> Result<()> {
    let seeds: [&[u8]; 2] = [b"freeze_authority", &[bump]];
    let signer_seeds: [&[&[u8]]; 1] = [&seeds];
    let cpi_ctx = CpiContext::new_with_signer(
        token_program,
        ThawAccount {
            account: token_account,
            mint,
            authority: freeze_authority,
        },
        &signer_seeds,
    );
    token::thaw_account(cpi_ctx)
}

fn cleanup_giftcard(giftcard: &mut Account<Giftcard>) -> Result<()> {
    require!(giftcard.unwrapped, GiftcardError::NotUnwrapped);
    giftcard.consumed = true;
    giftcard.key_handle = Vec::new();
    giftcard.cipher_ref = String::new();
    Ok(())
}

#[error_code]
pub enum GiftcardError {
    CipherRefTooLong,
    KeyHandleTooLong,
    AlreadyUnwrapped,
    NotOwner,
    InvalidBackend,
    Unauthorized,
    UnauthorizedGateway,
    FreezeAuthorityMismatch,
    InvalidConfig,
    InvalidMint,
    NotUnwrapped,
    InvalidRemainingAccounts,
    InvalidPermission,
    MissingBackendSignature,
    AuthorizationMessageTooLong,
    InvalidConfidentialProgram,
    InvalidCiphertext,
}
