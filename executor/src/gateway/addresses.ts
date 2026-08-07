/**
 * The single home for the Gateway contract addresses. The GatewayWallet address literal appears
 * ONLY here. Everything else imports it, so a bare ERC-20 transfer to the GatewayWallet, which
 * loses the USDC unrecoverably, cannot be written against a scattered literal. The
 * gateway-no-bare-transfer test enforces that this is the only file the literal appears in.
 *
 * These addresses are shared across all EVM testnets (V23, Circle Gateway references).
 */
export const GATEWAY_WALLET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9" as `0x${string}`;
export const GATEWAY_MINTER = "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B" as `0x${string}`;
