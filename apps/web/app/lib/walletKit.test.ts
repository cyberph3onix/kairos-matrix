// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";

const refreshSupportedWalletsMock = vi.fn();
const setWalletMock = vi.fn();
const fetchAddressMock = vi.fn().mockResolvedValue({ address: "GBDRXBYI7UWYP6EIXDAIIRWHP7RK4AZNXR7U7BGWQ7VHVURFAZGYHJXK" });
const activeModulesSignal = {
  value: [
    { productId: "freighter", productName: "Freighter", isAvailable: async () => true },
    { productId: "varial", productName: "Varial", isAvailable: async () => true },
  ],
};

vi.mock("@creit.tech/stellar-wallets-kit", () => ({
  StellarWalletsKit: {
    init: vi.fn(),
    refreshSupportedWallets: () => refreshSupportedWalletsMock(),
    setWallet: (id: string) => setWalletMock(id),
    fetchAddress: () => fetchAddressMock(),
    activeModules: activeModulesSignal,
  },
  Networks: { TESTNET: "TESTNET", PUBLIC: "PUBLIC" },
  SwkAppDarkTheme: {},
}));

vi.mock("@creit.tech/stellar-wallets-kit/modules/freighter", () => {
  class FreighterModule {
    productId = "varial";
    productName = "Varial";
  }
  return { FreighterModule };
});

vi.mock("@creit.tech/stellar-wallets-kit/modules/albedo", () => ({
  AlbedoModule: vi.fn(),
}));
vi.mock("@creit.tech/stellar-wallets-kit/modules/xbull", () => ({
  xBullModule: vi.fn(),
}));
vi.mock("@creit.tech/stellar-wallets-kit/modules/hotwallet", () => ({
  HotWalletModule: vi.fn(),
}));
vi.mock("@creit.tech/stellar-wallets-kit/modules/rabet", () => ({
  RabetModule: vi.fn(),
}));
vi.mock("@creit.tech/stellar-wallets-kit/modules/lobstr", () => ({
  LobstrModule: vi.fn(),
}));
vi.mock("@creit.tech/stellar-wallets-kit/modules/hana", () => ({
  HanaModule: vi.fn(),
}));
vi.mock("@creit.tech/stellar-wallets-kit/modules/klever", () => ({
  KleverModule: vi.fn(),
}));

vi.mock("@stellar/freighter-api", () => ({
  isConnected: vi.fn().mockResolvedValue({ isConnected: true }),
  requestAccess: vi.fn().mockResolvedValue({ address: "GBDRXBYI7UWYP6EIXDAIIRWHP7RK4AZNXR7U7BGWQ7VHVURFAZGYHJXK" }),
  getNetwork: vi.fn().mockResolvedValue({ network: "TESTNET", networkPassphrase: "Test SDF Network ; September 2015" }),
  getNetworkDetails: vi.fn().mockResolvedValue({ network: "TESTNET", networkPassphrase: "Test SDF Network ; September 2015" }),
}));

import { kitListWallets, kitConnectWallet, kitGetNetwork } from "./walletKit";

describe("walletKit Freighter integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("kitListWallets always places Freighter at index 0 with id 'freighter' and name 'Freighter'", async () => {
    refreshSupportedWalletsMock.mockResolvedValue([
      { id: "varial", name: "Varial", icon: "varial.png", isAvailable: true },
      { id: "albedo", name: "Albedo", icon: "albedo.png", isAvailable: false },
    ]);

    const wallets = await kitListWallets();
    expect(wallets.length).toBe(2);
    expect(wallets[0].id).toBe("freighter");
    expect(wallets[0].name).toBe("Freighter");
    expect(wallets[0].isAvailable).toBe(true);
    expect(wallets[1].id).toBe("albedo");
  });

  it("kitConnectWallet('freighter') selects the kit module and gets the address from Freighter directly", async () => {
    const address = await kitConnectWallet("freighter");
    expect(address).toBe("GBDRXBYI7UWYP6EIXDAIIRWHP7RK4AZNXR7U7BGWQ7VHVURFAZGYHJXK");
    expect(setWalletMock).toHaveBeenCalledWith("freighter");
    expect(fetchAddressMock).not.toHaveBeenCalled();
  });

  it("kitGetNetwork returns Freighter testnet details", async () => {
    const net = await kitGetNetwork();
    expect(net.network).toBe("TESTNET");
    expect(net.networkPassphrase).toBe("Test SDF Network ; September 2015");
  });
});
