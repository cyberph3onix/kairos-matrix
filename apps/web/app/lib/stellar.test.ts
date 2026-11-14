// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { Networks } from "@stellar/stellar-sdk";

const kitGetAddressMock = vi.fn();
const kitGetNetworkMock = vi.fn();

vi.mock("@/app/lib/walletKit", () => ({
  kitGetAddress: () => kitGetAddressMock(),
  kitGetNetwork: () => kitGetNetworkMock(),
  kitSignTransaction: vi.fn(),
  kitSignAuthEntry: vi.fn(),
  kitSignMessage: vi.fn(),
  kitDisconnect: vi.fn(),
}));

// Mock Horizon fetch
vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  return {
    ...actual,
    Horizon: {
      Server: vi.fn().mockImplementation(() => ({
        loadAccount: vi.fn().mockResolvedValue({
          balances: [{ asset_type: "native", balance: "150.5000000" }],
        }),
      })),
    },
  };
});

import { connectWallet, tryCheckConnection } from "./stellar";

describe("connectWallet & tryCheckConnection network enforcement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("connects successfully when Freighter is on Stellar Testnet", async () => {
    kitGetNetworkMock.mockResolvedValue({
      network: "TESTNET",
      networkPassphrase: Networks.TESTNET,
    });

    const res = await connectWallet("GBDRXBYI7UWYP6EIXDAIIRWHP7RK4AZNXR7U7BGWQ7VHVURFAZGYHJXK");
    expect(res.success).toBe(true);
    expect(res.wallet).toBeDefined();
    expect(res.wallet?.isTestnet).toBe(true);
    expect(res.wallet?.network).toBe("TESTNET");
    expect(res.wallet?.networkPassphrase).toBe(Networks.TESTNET);
    expect(res.wallet?.sorobanRpcUrl).toBe("https://soroban-testnet.stellar.org");
    expect(res.wallet?.balance).toBe("150.5000000");
  });

  it("rejects connection when Freighter is on Mainnet / Public", async () => {
    kitGetNetworkMock.mockResolvedValue({
      network: "PUBLIC",
      networkPassphrase: Networks.PUBLIC,
    });

    const res = await connectWallet("GBDRXBYI7UWYP6EIXDAIIRWHP7RK4AZNXR7U7BGWQ7VHVURFAZGYHJXK");
    expect(res.success).toBe(false);
    expect(res.error?.kind).toBe("network-error");
    expect(res.error?.message).toContain("Kairos requires Stellar Testnet");
    expect(res.error?.message).toContain("PUBLIC");
  });

  it("rejects connection when wallet reports an unrecognized network", async () => {
    kitGetNetworkMock.mockResolvedValue({
      network: "CUSTOM",
      networkPassphrase: "Custom Private Network ; 2026",
    });

    const res = await connectWallet("GBDRXBYI7UWYP6EIXDAIIRWHP7RK4AZNXR7U7BGWQ7VHVURFAZGYHJXK");
    expect(res.success).toBe(false);
    expect(res.error?.kind).toBe("network-error");
  });

  it("tryCheckConnection returns true only if connected on Testnet", async () => {
    kitGetAddressMock.mockResolvedValue("GBDRXBYI7UWYP6EIXDAIIRWHP7RK4AZNXR7U7BGWQ7VHVURFAZGYHJXK");
    kitGetNetworkMock.mockResolvedValue({
      network: "TESTNET",
      networkPassphrase: Networks.TESTNET,
    });

    const connected = await tryCheckConnection();
    expect(connected).toBe(true);
  });

  it("tryCheckConnection returns false if wallet is on Mainnet", async () => {
    kitGetAddressMock.mockResolvedValue("GBDRXBYI7UWYP6EIXDAIIRWHP7RK4AZNXR7U7BGWQ7VHVURFAZGYHJXK");
    kitGetNetworkMock.mockResolvedValue({
      network: "PUBLIC",
      networkPassphrase: Networks.PUBLIC,
    });

    const connected = await tryCheckConnection();
    expect(connected).toBe(false);
  });
});
