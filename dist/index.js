// src/actions/bridge.ts
import { composePrompt, ModelType } from "@elizaos/core";
import { createConfig, executeRoute, getRoutes } from "@lifi/sdk";
import { parseEther } from "viem";

// src/providers/wallet.ts
import * as path from "node:path";
import {
  elizaLogger
} from "@elizaos/core";
import { PhalaDeriveKeyProvider, TEEMode } from "@elizaos/plugin-tee";
import {
  http,
  createPublicClient,
  createTestClient,
  createWalletClient,
  formatUnits,
  publicActions,
  walletActions
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as viemChains from "viem/chains";

// src/constants.ts
var EVM_WALLET_DATA_CACHE_KEY = "evm/wallet/data";
var EVM_SERVICE_NAME = "evmService";
var CACHE_REFRESH_INTERVAL_MS = 60 * 1e3;

// src/providers/wallet.ts
var WalletProvider = class {
  cacheKey = "evm/wallet";
  chains = { ...viemChains };
  account;
  runtime;
  constructor(accountOrPrivateKey, runtime, chains) {
    this.setAccount(accountOrPrivateKey);
    this.addChains(chains);
    this.runtime = runtime;
  }
  getAddress() {
    return this.account.address;
  }
  getPublicClient(chainName) {
    const transport = this.createHttpTransport(chainName);
    const publicClient = createPublicClient({
      chain: this.chains[chainName],
      transport
    });
    return publicClient;
  }
  getWalletClient(chainName) {
    const transport = this.createHttpTransport(chainName);
    const walletClient = createWalletClient({
      chain: this.chains[chainName],
      transport,
      account: this.account
    });
    return walletClient;
  }
  getTestClient() {
    return createTestClient({
      chain: viemChains.hardhat,
      mode: "hardhat",
      transport: http()
    }).extend(publicActions).extend(walletActions);
  }
  getChainConfigs(chainName) {
    const chain = this.chains[chainName];
    if (!chain?.id) {
      throw new Error(`Invalid chain name: ${chainName}`);
    }
    return chain;
  }
  getSupportedChains() {
    return Object.keys(this.chains);
  }
  async getWalletBalances() {
    const cacheKey = path.join(this.cacheKey, "walletBalances");
    const cachedData = await this.runtime.getCache(cacheKey);
    if (cachedData) {
      elizaLogger.log(`Returning cached wallet balances`);
      return cachedData;
    }
    const balances = {};
    const chainNames = this.getSupportedChains();
    await Promise.all(
      chainNames.map(async (chainName) => {
        try {
          const balance = await this.getWalletBalanceForChain(chainName);
          if (balance !== null) {
            balances[chainName] = balance;
          }
        } catch (error) {
          elizaLogger.error(`Error getting balance for ${chainName}:`, error);
        }
      })
    );
    await this.runtime.setCache(cacheKey, balances);
    elizaLogger.log("Wallet balances cached");
    return balances;
  }
  async getWalletBalanceForChain(chainName) {
    try {
      const client = this.getPublicClient(chainName);
      const balance = await client.getBalance({
        address: this.account.address
      });
      return formatUnits(balance, 18);
    } catch (error) {
      console.error(`Error getting wallet balance for ${chainName}:`, error);
      return null;
    }
  }
  addChain(chain) {
    this.addChains(chain);
  }
  setAccount = (accountOrPrivateKey) => {
    if (typeof accountOrPrivateKey === "string") {
      this.account = privateKeyToAccount(accountOrPrivateKey);
    } else {
      this.account = accountOrPrivateKey;
    }
  };
  addChains = (chains) => {
    if (!chains) {
      return;
    }
    for (const chain of Object.keys(chains)) {
      this.chains[chain] = chains[chain];
    }
  };
  createHttpTransport = (chainName) => {
    const chain = this.chains[chainName];
    if (!chain) {
      throw new Error(`Chain not found: ${chainName}`);
    }
    if (chain.rpcUrls.custom) {
      return http(chain.rpcUrls.custom.http[0]);
    }
    return http(chain.rpcUrls.default.http[0]);
  };
  static genChainFromName(chainName, customRpcUrl) {
    const baseChain = viemChains[chainName];
    if (!baseChain?.id) {
      throw new Error("Invalid chain name");
    }
    const viemChain = customRpcUrl ? {
      ...baseChain,
      rpcUrls: {
        ...baseChain.rpcUrls,
        custom: {
          http: [customRpcUrl]
        }
      }
    } : baseChain;
    return viemChain;
  }
};
var genChainsFromRuntime = (runtime) => {
  const configuredChains = runtime.character.settings.chains?.evm || [];
  const defaultChains = ["mainnet", "polygon", "arbitrum", "base", "optimism", "linea"];
  const chainNames = [.../* @__PURE__ */ new Set([...configuredChains, ...defaultChains])];
  const chains = {};
  for (const chainName of chainNames) {
    try {
      let rpcUrl = runtime.getSetting(`ETHEREUM_PROVIDER_${chainName.toUpperCase()}`);
      if (!rpcUrl) {
        rpcUrl = runtime.getSetting(`EVM_PROVIDER_${chainName.toUpperCase()}`);
      }
      if (!viemChains[chainName]) {
        elizaLogger.warn(`Chain ${chainName} not found in viem chains, skipping`);
        continue;
      }
      const chain = WalletProvider.genChainFromName(chainName, rpcUrl);
      chains[chainName] = chain;
    } catch (error) {
      elizaLogger.error(`Error configuring chain ${chainName}:`, error);
    }
  }
  return chains;
};
var initWalletProvider = async (runtime) => {
  const teeMode = runtime.getSetting("TEE_MODE") || TEEMode.OFF;
  const chains = genChainsFromRuntime(runtime);
  if (teeMode !== TEEMode.OFF) {
    const walletSecretSalt = runtime.getSetting("WALLET_SECRET_SALT");
    if (!walletSecretSalt) {
      throw new Error("WALLET_SECRET_SALT required when TEE_MODE is enabled");
    }
    const deriveKeyProvider = new PhalaDeriveKeyProvider(teeMode);
    const deriveKeyResult = await deriveKeyProvider.deriveEcdsaKeypair(
      walletSecretSalt,
      "evm",
      runtime.agentId
    );
    return new WalletProvider(deriveKeyResult.keypair, runtime, chains);
  }
  const privateKey = runtime.getSetting("EVM_PRIVATE_KEY");
  if (!privateKey) {
    throw new Error("EVM_PRIVATE_KEY is missing");
  }
  return new WalletProvider(privateKey, runtime, chains);
};
var evmWalletProvider = {
  name: "EVMWalletProvider",
  async get(runtime, _message, state) {
    try {
      const evmService = runtime.getService(EVM_SERVICE_NAME);
      if (!evmService) {
        elizaLogger.warn("EVM service not found, falling back to direct fetching");
        return await directFetchWalletData(runtime, state);
      }
      const walletData = await evmService.getCachedData();
      if (!walletData) {
        elizaLogger.warn("No cached wallet data available, falling back to direct fetching");
        return await directFetchWalletData(runtime, state);
      }
      const agentName = state?.agentName || "The agent";
      const balanceText = walletData.chains.map((chain) => `${chain.name}: ${chain.balance} ${chain.symbol}`).join("\n");
      return {
        text: `${agentName}'s EVM Wallet Address: ${walletData.address}

Balances:
${balanceText}`,
        data: {
          address: walletData.address,
          chains: walletData.chains
        },
        values: {
          address: walletData.address,
          chains: JSON.stringify(walletData.chains)
        }
      };
    } catch (error) {
      console.error("Error in EVM wallet provider:", error);
      return {
        text: "Error getting EVM wallet provider",
        data: {},
        values: {}
      };
    }
  }
};
async function directFetchWalletData(runtime, state) {
  try {
    const walletProvider = await initWalletProvider(runtime);
    const address = walletProvider.getAddress();
    const balances = await walletProvider.getWalletBalances();
    const agentName = state?.agentName || "The agent";
    const chainDetails = Object.entries(balances).map(([chainName, balance]) => {
      const chain = walletProvider.getChainConfigs(chainName);
      return {
        chainName,
        balance,
        symbol: chain.nativeCurrency.symbol,
        chainId: chain.id,
        name: chain.name
      };
    });
    const balanceText = chainDetails.map((chain) => `${chain.name}: ${chain.balance} ${chain.symbol}`).join("\n");
    return {
      text: `${agentName}'s EVM Wallet Address: ${address}

Balances:
${balanceText}`,
      data: {
        address,
        chains: chainDetails
      },
      values: {
        address,
        chains: JSON.stringify(chainDetails)
      }
    };
  } catch (error) {
    console.error("Error fetching wallet data directly:", error);
    return {
      text: "Error getting EVM wallet provider",
      data: {},
      values: {}
    };
  }
}

// src/templates/index.ts
var transferTemplate = `You are an AI assistant specialized in processing cryptocurrency transfer requests. Your task is to extract specific information from user messages and format it into a structured JSON response.

First, review the recent messages from the conversation:

<recent_messages>
{{recentMessages}}
</recent_messages>

Here's a list of supported chains:
<supported_chains>
{{supportedChains}}
</supported_chains>

Your goal is to extract the following information about the requested transfer:
1. Chain to execute on (must be one of the supported chains)
2. Amount to transfer (in ETH, without the coin symbol)
3. Recipient address (must be a valid Ethereum address)
4. Token symbol or address (if not a native token transfer)

Before providing the final JSON output, show your reasoning process inside <analysis> tags. Follow these steps:

1. Identify the relevant information from the user's message:
   - Quote the part of the message mentioning the chain.
   - Quote the part mentioning the amount.
   - Quote the part mentioning the recipient address.
   - Quote the part mentioning the token (if any).

2. Validate each piece of information:
   - Chain: List all supported chains and check if the mentioned chain is in the list.
   - Amount: Attempt to convert the amount to a number to verify it's valid.
   - Address: Check that it starts with "0x" and count the number of characters (should be 42).
   - Token: Note whether it's a native transfer or if a specific token is mentioned.

3. If any information is missing or invalid, prepare an appropriate error message.

4. If all information is valid, summarize your findings.

5. Prepare the JSON structure based on your analysis.

After your analysis, provide the final output in a JSON markdown block. All fields except 'token' are required. The JSON should have this structure:

\`\`\`json
{
    "fromChain": string,
    "amount": string,
    "toAddress": string,
    "token": string | null
}
\`\`\`

Remember:
- The chain name must be a string and must exactly match one of the supported chains.
- The amount should be a string representing the number without any currency symbol.
- The recipient address must be a valid Ethereum address starting with "0x".
- If no specific token is mentioned (i.e., it's a native token transfer), set the "token" field to null.

Now, process the user's request and provide your response.
`;
var bridgeTemplate = `Given the recent messages and wallet information below:

{{recentMessages}}

{{walletInfo}}

Extract the following information about the requested token bridge:
- Token symbol or address to bridge
- Source chain
- Destination chain
- Amount to bridge: Must be a string representing the amount in ether (only number without coin symbol, e.g., "0.1")
- Destination address (if specified)

Respond with a JSON markdown block containing only the extracted values:

\`\`\`json
{
    "token": string | null,
    "fromChain": "ethereum" | "abstract" | "base" | "sepolia" | "bsc" | "arbitrum" | "avalanche" | "polygon" | "optimism" | "cronos" | "gnosis" | "fantom" | "fraxtal" | "klaytn" | "celo" | "moonbeam" | "aurora" | "harmonyOne" | "moonriver" | "arbitrumNova" | "mantle" | "linea" | "scroll" | "filecoin" | "taiko" | "zksync" | "canto" | "alienx" | "gravity" | null,
    "toChain": "ethereum" | "abstract" | "base" | "sepolia" | "bsc" | "arbitrum" | "avalanche" | "polygon" | "optimism" | "cronos" | "gnosis" | "fantom" | "fraxtal" | "klaytn" | "celo" | "moonbeam" | "aurora" | "harmonyOne" | "moonriver" | "arbitrumNova" | "mantle" | "linea" | "scroll" | "filecoin" | "taiko" | "zksync" | "canto" | "alienx" | "gravity" |  null,
    "amount": string | null,
    "toAddress": string | null
}
\`\`\`
`;
var swapTemplate = `Given the recent messages and wallet information below:

{{recentMessages}}

{{walletInfo}}

Extract the following information about the requested token swap:
- Input token symbol or address (the token being sold)
- Output token symbol or address (the token being bought)
- Amount to swap: Must be a string representing the amount in ether (only number without coin symbol, e.g., "0.1")
- Chain to execute on

Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined:

\`\`\`json
{
    "inputToken": string | null,
    "outputToken": string | null,
    "amount": string | null,
    "chain": "ethereum" | "abstract" | "base" | "sepolia" | "bsc" | "arbitrum" | "avalanche" | "polygon" | "optimism" | "cronos" | "gnosis" | "fantom" | "klaytn" | "celo" | "moonbeam" | "aurora" | "harmonyOne" | "moonriver" | "arbitrumNova" | "mantle" | "linea" | "scroll" | "filecoin" | "taiko" | "zksync" | "canto" | "alienx" | null,
    "slippage": number | null
}
\`\`\`
`;

// src/actions/bridge.ts
var BridgeAction = class {
  constructor(walletProvider) {
    this.walletProvider = walletProvider;
    this.config = createConfig({
      integrator: "eliza",
      chains: Object.values(this.walletProvider.chains).map((config) => ({
        id: config.id,
        name: config.name,
        key: config.name.toLowerCase(),
        chainType: "EVM",
        nativeToken: {
          ...config.nativeCurrency,
          chainId: config.id,
          address: "0x0000000000000000000000000000000000000000",
          coinKey: config.nativeCurrency.symbol
        },
        metamask: {
          chainId: `0x${config.id.toString(16)}`,
          chainName: config.name,
          nativeCurrency: config.nativeCurrency,
          rpcUrls: [config.rpcUrls.default.http[0]],
          blockExplorerUrls: [config.blockExplorers.default.url]
        },
        diamondAddress: "0x0000000000000000000000000000000000000000",
        coin: config.nativeCurrency.symbol,
        mainnet: true
      }))
    });
  }
  config;
  async bridge(params) {
    const walletClient = this.walletProvider.getWalletClient(params.fromChain);
    const [fromAddress] = await walletClient.getAddresses();
    const routes = await getRoutes({
      fromChainId: this.walletProvider.getChainConfigs(params.fromChain).id,
      toChainId: this.walletProvider.getChainConfigs(params.toChain).id,
      fromTokenAddress: params.fromToken,
      toTokenAddress: params.toToken,
      fromAmount: parseEther(params.amount).toString(),
      fromAddress,
      toAddress: params.toAddress || fromAddress
    });
    if (!routes.routes.length) throw new Error("No routes found");
    const execution = await executeRoute(routes.routes[0], this.config);
    const process = execution.steps[0]?.execution?.process[0];
    if (!process?.status || process.status === "FAILED") {
      throw new Error("Transaction failed");
    }
    return {
      hash: process.txHash,
      from: fromAddress,
      to: routes.routes[0].steps[0].estimate.approvalAddress,
      value: BigInt(params.amount),
      chainId: this.walletProvider.getChainConfigs(params.fromChain).id
    };
  }
};
var buildBridgeDetails = async (state, runtime, wp) => {
  const chains = wp.getSupportedChains();
  state.supportedChains = chains.map((item) => `"${item}"`).join("|");
  const balances = await wp.getWalletBalances();
  state.chainBalances = Object.entries(balances).map(([chain, balance]) => {
    const chainConfig = wp.getChainConfigs(chain);
    return `${chain}: ${balance} ${chainConfig.nativeCurrency.symbol}`;
  }).join(", ");
  const bridgeContext = composePrompt({
    state,
    template: bridgeTemplate
  });
  const content = await runtime.useModel(ModelType.OBJECT_LARGE, {
    context: bridgeContext
  });
  const fromChain = content.fromChain;
  const toChain = content.toChain;
  if (!wp.chains[fromChain]) {
    throw new Error(
      `Source chain ${fromChain} not configured. Available chains: ${chains.join(", ")}`
    );
  }
  if (!wp.chains[toChain]) {
    throw new Error(
      `Destination chain ${toChain} not configured. Available chains: ${chains.join(", ")}`
    );
  }
  const bridgeOptions = {
    fromChain: content.fromChain,
    toChain: content.toChain,
    fromToken: content.token,
    toToken: content.token,
    toAddress: content.toAddress,
    amount: content.amount
  };
  return bridgeOptions;
};
var bridgeAction = {
  name: "EVM_BRIDGE_TOKENS",
  description: "Bridge tokens between different chains",
  handler: async (runtime, _message, state, _options, callback) => {
    const walletProvider = await initWalletProvider(runtime);
    const action = new BridgeAction(walletProvider);
    try {
      const bridgeOptions = await buildBridgeDetails(state, runtime, walletProvider);
      const bridgeResp = await action.bridge(bridgeOptions);
      if (callback) {
        callback({
          text: `Successfully bridged ${bridgeOptions.amount} tokens from ${bridgeOptions.fromChain} to ${bridgeOptions.toChain}
Transaction Hash: ${bridgeResp.hash}`,
          content: {
            success: true,
            hash: bridgeResp.hash,
            recipient: bridgeResp.to,
            fromChain: bridgeOptions.fromChain,
            toChain: bridgeOptions.toChain
          }
        });
      }
      return true;
    } catch (error) {
      console.error("Error in bridge handler:", error.message);
      if (callback) {
        callback({
          text: `Error: ${error.message}`,
          content: { error: error.message }
        });
      }
      return false;
    }
  },
  template: bridgeTemplate,
  validate: async (runtime) => {
    const privateKey = runtime.getSetting("EVM_PRIVATE_KEY");
    return typeof privateKey === "string" && privateKey.startsWith("0x");
  },
  examples: [
    [
      {
        user: "user",
        content: {
          text: "Bridge 1 ETH from Ethereum to Base",
          action: "CROSS_CHAIN_TRANSFER"
        }
      }
    ]
  ],
  similes: ["CROSS_CHAIN_TRANSFER", "CHAIN_BRIDGE", "MOVE_CROSS_CHAIN"]
};

// src/actions/swap.ts
import { ModelType as ModelType2, composePrompt as composePrompt2, elizaLogger as elizaLogger2 } from "@elizaos/core";
import { createConfig as createConfig2, executeRoute as executeRoute2, getRoutes as getRoutes2 } from "@lifi/sdk";
import {
  encodeFunctionData,
  parseAbi,
  parseUnits
} from "viem";
var SwapAction = class {
  constructor(walletProvider) {
    this.walletProvider = walletProvider;
    this.walletProvider = walletProvider;
    const lifiChains = [];
    for (const config of Object.values(this.walletProvider.chains)) {
      try {
        lifiChains.push({
          id: config.id,
          name: config.name,
          key: config.name.toLowerCase(),
          chainType: "EVM",
          nativeToken: {
            ...config.nativeCurrency,
            chainId: config.id,
            address: "0x0000000000000000000000000000000000000000",
            coinKey: config.nativeCurrency.symbol,
            priceUSD: "0",
            logoURI: "",
            symbol: config.nativeCurrency.symbol,
            decimals: config.nativeCurrency.decimals,
            name: config.nativeCurrency.name
          },
          rpcUrls: {
            public: { http: [config.rpcUrls.default.http[0]] }
          },
          blockExplorerUrls: [config.blockExplorers.default.url],
          metamask: {
            chainId: `0x${config.id.toString(16)}`,
            chainName: config.name,
            nativeCurrency: config.nativeCurrency,
            rpcUrls: [config.rpcUrls.default.http[0]],
            blockExplorerUrls: [config.blockExplorers.default.url]
          },
          coin: config.nativeCurrency.symbol,
          mainnet: true,
          diamondAddress: "0x0000000000000000000000000000000000000000"
        });
      } catch {
      }
    }
    this.lifiConfig = createConfig2({
      integrator: "eliza",
      chains: lifiChains
    });
    this.bebopChainsMap = {
      mainnet: "ethereum",
      optimism: "optimism",
      polygon: "polygon",
      arbitrum: "arbitrum",
      base: "base",
      linea: "linea"
    };
  }
  lifiConfig;
  bebopChainsMap;
  async swap(params) {
    const walletClient = this.walletProvider.getWalletClient(params.chain);
    const [fromAddress] = await walletClient.getAddresses();
    const sortedQuotes = await this.getSortedQuotes(fromAddress, params);
    for (const quote of sortedQuotes) {
      let res;
      switch (quote.aggregator) {
        case "lifi":
          res = await this.executeLifiQuote(quote);
          break;
        case "bebop":
          res = await this.executeBebopQuote(quote, params);
          break;
        default:
          throw new Error("No aggregator found");
      }
      if (res !== void 0) return res;
    }
    throw new Error("Execution failed");
  }
  async getSortedQuotes(fromAddress, params) {
    const decimalsAbi = parseAbi(["function decimals() view returns (uint8)"]);
    const decimals = await this.walletProvider.getPublicClient(params.chain).readContract({
      address: params.fromToken,
      abi: decimalsAbi,
      functionName: "decimals"
    });
    const quotes = await Promise.all([
      this.getLifiQuote(fromAddress, params, decimals),
      this.getBebopQuote(fromAddress, params, decimals)
    ]);
    const sortedQuotes = quotes.filter((quote) => quote !== void 0);
    sortedQuotes.sort((a, b) => BigInt(a.minOutputAmount) > BigInt(b.minOutputAmount) ? -1 : 1);
    if (sortedQuotes.length === 0) throw new Error("No routes found");
    return sortedQuotes;
  }
  async getLifiQuote(fromAddress, params, fromTokenDecimals) {
    try {
      const routes = await getRoutes2({
        fromChainId: this.walletProvider.getChainConfigs(params.chain).id,
        toChainId: this.walletProvider.getChainConfigs(params.chain).id,
        fromTokenAddress: params.fromToken,
        toTokenAddress: params.toToken,
        fromAmount: parseUnits(params.amount, fromTokenDecimals).toString(),
        fromAddress,
        options: {
          slippage: params.slippage / 100 || 5e-3,
          order: "RECOMMENDED"
        }
      });
      if (!routes.routes.length) throw new Error("No routes found");
      return {
        aggregator: "lifi",
        minOutputAmount: routes.routes[0].steps[0].estimate.toAmountMin,
        swapData: routes.routes[0]
      };
    } catch (error) {
      elizaLogger2.error("Error in getLifiQuote:", error.message);
      return void 0;
    }
  }
  async getBebopQuote(fromAddress, params, fromTokenDecimals) {
    try {
      const url = `https://api.bebop.xyz/router/${this.bebopChainsMap[params.chain] ?? params.chain}/v1/quote`;
      const reqParams = new URLSearchParams({
        sell_tokens: params.fromToken,
        buy_tokens: params.toToken,
        sell_amounts: parseUnits(params.amount, fromTokenDecimals).toString(),
        taker_address: fromAddress,
        approval_type: "Standard",
        skip_validation: "true",
        gasless: "false",
        source: "eliza"
      });
      const response = await fetch(`${url}?${reqParams.toString()}`, {
        method: "GET",
        headers: { accept: "application/json" }
      });
      if (!response.ok) {
        throw Error(response.statusText);
      }
      const data = await response.json();
      const route = {
        data: data.routes[0].quote.tx.data,
        sellAmount: parseUnits(params.amount, fromTokenDecimals).toString(),
        approvalTarget: data.routes[0].quote.approvalTarget,
        from: data.routes[0].quote.tx.from,
        value: data.routes[0].quote.tx.value.toString(),
        to: data.routes[0].quote.tx.to,
        gas: data.routes[0].quote.tx.gas.toString(),
        gasPrice: data.routes[0].quote.tx.gasPrice.toString()
      };
      return {
        aggregator: "bebop",
        minOutputAmount: data.routes[0].quote.buyTokens[params.toToken].minimumAmount.toString(),
        swapData: route
      };
    } catch (error) {
      elizaLogger2.error("Error in getBebopQuote:", error.message);
      return void 0;
    }
  }
  async executeLifiQuote(quote) {
    try {
      const route = quote.swapData;
      const execution = await executeRoute2(quote.swapData, this.lifiConfig);
      const process = execution.steps[0]?.execution?.process[0];
      if (!process?.status || process.status === "FAILED") {
        throw new Error("Transaction failed");
      }
      return {
        hash: process.txHash,
        from: route.fromAddress,
        to: route.steps[0].estimate.approvalAddress,
        value: 0n,
        data: process.data,
        chainId: route.fromChainId
      };
    } catch (error) {
      elizaLogger2.error(`Failed to execute lifi quote: ${error}`);
      return void 0;
    }
  }
  async executeBebopQuote(quote, params) {
    try {
      const bebopRoute = quote.swapData;
      const allowanceAbi = parseAbi(["function allowance(address,address) view returns (uint256)"]);
      const allowance = await this.walletProvider.getPublicClient(params.chain).readContract({
        address: params.fromToken,
        abi: allowanceAbi,
        functionName: "allowance",
        args: [bebopRoute.from, bebopRoute.approvalTarget]
      });
      if (allowance < BigInt(bebopRoute.sellAmount)) {
        const approvalData = encodeFunctionData({
          abi: parseAbi(["function approve(address,uint256)"]),
          functionName: "approve",
          args: [bebopRoute.approvalTarget, BigInt(bebopRoute.sellAmount)]
        });
        await this.walletProvider.getWalletClient(params.chain).sendTransaction({
          account: this.walletProvider.getWalletClient(params.chain).account,
          to: params.fromToken,
          value: 0n,
          data: approvalData,
          kzg: {
            blobToKzgCommitment: (_) => {
              throw new Error("Function not implemented.");
            },
            computeBlobKzgProof: (_blob, _commitment) => {
              throw new Error("Function not implemented.");
            }
          },
          chain: void 0
        });
      }
      const hash = await this.walletProvider.getWalletClient(params.chain).sendTransaction({
        account: this.walletProvider.getWalletClient(params.chain).account,
        to: bebopRoute.to,
        value: BigInt(bebopRoute.value),
        data: bebopRoute.data,
        kzg: {
          blobToKzgCommitment: (_) => {
            throw new Error("Function not implemented.");
          },
          computeBlobKzgProof: (_blob, _commitment) => {
            throw new Error("Function not implemented.");
          }
        },
        chain: void 0
      });
      return {
        hash,
        from: this.walletProvider.getWalletClient(params.chain).account.address,
        to: bebopRoute.to,
        value: BigInt(bebopRoute.value),
        data: bebopRoute.data
      };
    } catch (error) {
      elizaLogger2.error(`Failed to execute bebop quote: ${error}`);
      return void 0;
    }
  }
};
var buildSwapDetails = async (state, runtime, wp) => {
  const chains = wp.getSupportedChains();
  state.supportedChains = chains.map((item) => `"${item}"`).join("|");
  const balances = await wp.getWalletBalances();
  state.chainBalances = Object.entries(balances).map(([chain2, balance]) => {
    const chainConfig = wp.getChainConfigs(chain2);
    return `${chain2}: ${balance} ${chainConfig.nativeCurrency.symbol}`;
  }).join(", ");
  const context = composePrompt2({
    state,
    template: swapTemplate
  });
  const swapDetails = await runtime.useModel(ModelType2.OBJECT_SMALL, {
    context
  });
  const chain = swapDetails.chain;
  if (!wp.chains[chain]) {
    throw new Error(`Chain ${chain} not configured. Available chains: ${chains.join(", ")}`);
  }
  return swapDetails;
};
var swapAction = {
  name: "EVM_SWAP_TOKENS",
  description: "Swap tokens on the same chain",
  handler: async (runtime, _message, state, _options, callback) => {
    const walletProvider = await initWalletProvider(runtime);
    const action = new SwapAction(walletProvider);
    try {
      const swapOptions = await buildSwapDetails(state, runtime, walletProvider);
      const swapResp = await action.swap(swapOptions);
      if (callback) {
        callback({
          text: `Successfully swapped ${swapOptions.amount} ${swapOptions.fromToken} for ${swapOptions.toToken} on ${swapOptions.chain}
Transaction Hash: ${swapResp.hash}`,
          content: {
            success: true,
            hash: swapResp.hash,
            chain: swapOptions.chain
          }
        });
      }
      return true;
    } catch (error) {
      console.error("Error in swap handler:", error.message);
      if (callback) {
        callback({
          text: `Error: ${error.message}`,
          content: { error: error.message }
        });
      }
      return false;
    }
  },
  template: swapTemplate,
  validate: async (runtime) => {
    const privateKey = runtime.getSetting("EVM_PRIVATE_KEY");
    return typeof privateKey === "string" && privateKey.startsWith("0x");
  },
  examples: [
    [
      {
        user: "user",
        content: {
          text: "Swap 1 WETH for USDC on Arbitrum",
          action: "TOKEN_SWAP"
        }
      }
    ]
  ],
  similes: ["TOKEN_SWAP", "EXCHANGE_TOKENS", "TRADE_TOKENS"]
};

// src/actions/transfer.ts
import {
  ModelType as ModelType3,
  composePrompt as composePrompt3
} from "@elizaos/core";
import { formatEther, parseEther as parseEther2 } from "viem";
var TransferAction = class {
  constructor(walletProvider) {
    this.walletProvider = walletProvider;
  }
  async transfer(params) {
    if (!params.data) {
      params.data = "0x";
    }
    const walletClient = this.walletProvider.getWalletClient(params.fromChain);
    try {
      const hash = await walletClient.sendTransaction({
        account: walletClient.account,
        to: params.toAddress,
        value: parseEther2(params.amount),
        data: params.data,
        kzg: {
          blobToKzgCommitment: (_) => {
            throw new Error("Function not implemented.");
          },
          computeBlobKzgProof: (_blob, _commitment) => {
            throw new Error("Function not implemented.");
          }
        },
        chain: void 0
      });
      return {
        hash,
        from: walletClient.account.address,
        to: params.toAddress,
        value: parseEther2(params.amount),
        data: params.data
      };
    } catch (error) {
      throw new Error(`Transfer failed: ${error.message}`);
    }
  }
};
var buildTransferDetails = async (state, runtime, wp) => {
  const chains = wp.getSupportedChains();
  state.supportedChains = chains.map((item) => `"${item}"`).join("|");
  const balances = await wp.getWalletBalances();
  state.chainBalances = Object.entries(balances).map(([chain, balance]) => {
    const chainConfig = wp.getChainConfigs(chain);
    return `${chain}: ${balance} ${chainConfig.nativeCurrency.symbol}`;
  }).join(", ");
  const context = composePrompt3({
    state,
    template: transferTemplate
  });
  const transferDetails = await runtime.useModel(ModelType3.OBJECT_SMALL, {
    context
  });
  const existingChain = wp.chains[transferDetails.fromChain];
  if (!existingChain) {
    throw new Error(
      "The chain " + transferDetails.fromChain + " not configured yet. Add the chain or choose one from configured: " + chains.toString()
    );
  }
  return transferDetails;
};
var transferAction = {
  name: "EVM_TRANSFER_TOKENS",
  description: "Transfer tokens between addresses on the same chain",
  handler: async (runtime, message, state, _options, callback) => {
    if (!state) {
      state = await runtime.composeState(message);
    }
    const walletProvider = await initWalletProvider(runtime);
    const action = new TransferAction(walletProvider);
    const paramOptions = await buildTransferDetails(state, runtime, walletProvider);
    try {
      const transferResp = await action.transfer(paramOptions);
      if (callback) {
        callback({
          text: `Successfully transferred ${paramOptions.amount} tokens to ${paramOptions.toAddress}
Transaction Hash: ${transferResp.hash}`,
          content: {
            success: true,
            hash: transferResp.hash,
            amount: formatEther(transferResp.value),
            recipient: transferResp.to,
            chain: paramOptions.fromChain
          }
        });
      }
      return true;
    } catch (error) {
      console.error("Error during token transfer:", error);
      if (callback) {
        callback({
          text: `Error transferring tokens: ${error.message}`,
          content: { error: error.message }
        });
      }
      return false;
    }
  },
  validate: async (runtime) => {
    const privateKey = runtime.getSetting("EVM_PRIVATE_KEY");
    return typeof privateKey === "string" && privateKey.startsWith("0x");
  },
  examples: [
    [
      {
        name: "assistant",
        content: {
          text: "I'll help you transfer 1 ETH to 0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
          action: "SEND_TOKENS"
        }
      },
      {
        name: "user",
        content: {
          text: "Transfer 1 ETH to 0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
          action: "SEND_TOKENS"
        }
      }
    ]
  ],
  similes: ["EVM_TRANSFER", "EVM_SEND_TOKENS", "EVM_TOKEN_TRANSFER", "EVM_MOVE_TOKENS"]
};

// src/service.ts
import { Service, elizaLogger as elizaLogger3 } from "@elizaos/core";
var EVMService = class _EVMService extends Service {
  constructor(runtime) {
    super();
    this.runtime = runtime;
  }
  static serviceType = EVM_SERVICE_NAME;
  capabilityDescription = "EVM blockchain wallet access";
  walletProvider = null;
  refreshInterval = null;
  lastRefreshTimestamp = 0;
  static async start(runtime) {
    elizaLogger3.log("Initializing EVMService");
    const evmService = new _EVMService(runtime);
    evmService.walletProvider = await initWalletProvider(runtime);
    await evmService.refreshWalletData();
    if (evmService.refreshInterval) {
      clearInterval(evmService.refreshInterval);
    }
    evmService.refreshInterval = setInterval(
      () => evmService.refreshWalletData(),
      CACHE_REFRESH_INTERVAL_MS
    );
    elizaLogger3.log("EVM service initialized");
    return evmService;
  }
  static async stop(runtime) {
    const service = runtime.getService(EVM_SERVICE_NAME);
    if (!service) {
      elizaLogger3.error("EVMService not found");
      return;
    }
    await service.stop();
  }
  async stop() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
    elizaLogger3.log("EVM service shutdown");
  }
  async refreshWalletData() {
    try {
      if (!this.walletProvider) {
        this.walletProvider = await initWalletProvider(this.runtime);
      }
      const address = this.walletProvider.getAddress();
      const balances = await this.walletProvider.getWalletBalances();
      const chainDetails = Object.entries(balances).map(([chainName, balance]) => {
        try {
          const chain = this.walletProvider.getChainConfigs(chainName);
          return {
            chainName,
            balance,
            symbol: chain.nativeCurrency.symbol,
            chainId: chain.id,
            name: chain.name
          };
        } catch (error) {
          elizaLogger3.error(`Error formatting chain ${chainName}:`, error);
          return null;
        }
      }).filter(Boolean);
      const walletData = {
        address,
        chains: chainDetails,
        timestamp: Date.now()
      };
      await this.runtime.setCache(EVM_WALLET_DATA_CACHE_KEY, walletData);
      this.lastRefreshTimestamp = walletData.timestamp;
      elizaLogger3.log(
        "EVM wallet data refreshed for chains:",
        chainDetails.map((c) => c?.chainName).join(", ")
      );
    } catch (error) {
      elizaLogger3.error("Error refreshing EVM wallet data:", error);
    }
  }
  async getCachedData() {
    try {
      const cachedData = await this.runtime.getCache(EVM_WALLET_DATA_CACHE_KEY);
      const now = Date.now();
      if (!cachedData || now - cachedData.timestamp > CACHE_REFRESH_INTERVAL_MS) {
        elizaLogger3.log("EVM wallet data is stale, refreshing...");
        await this.refreshWalletData();
        return this.runtime.getCache(EVM_WALLET_DATA_CACHE_KEY);
      }
      return cachedData;
    } catch (error) {
      elizaLogger3.error("Error getting cached EVM wallet data:", error);
      return null;
    }
  }
  async forceUpdate() {
    await this.refreshWalletData();
    return this.getCachedData();
  }
};

// src/types/index.ts
import * as viemChains2 from "viem/chains";
var _SupportedChainList = Object.keys(viemChains2);
var VoteType = /* @__PURE__ */ ((VoteType2) => {
  VoteType2[VoteType2["AGAINST"] = 0] = "AGAINST";
  VoteType2[VoteType2["FOR"] = 1] = "FOR";
  VoteType2[VoteType2["ABSTAIN"] = 2] = "ABSTAIN";
  return VoteType2;
})(VoteType || {});

// src/index.ts
var evmPlugin = {
  name: "evm",
  description: "EVM blockchain integration plugin",
  providers: [evmWalletProvider],
  evaluators: [],
  services: [EVMService],
  actions: [transferAction, bridgeAction, swapAction]
};
var index_default = evmPlugin;
export {
  BridgeAction,
  EVMService,
  SwapAction,
  TransferAction,
  VoteType,
  WalletProvider,
  bridgeAction,
  bridgeTemplate,
  index_default as default,
  evmPlugin,
  evmWalletProvider,
  initWalletProvider,
  swapAction,
  swapTemplate,
  transferAction
};
//# sourceMappingURL=index.js.map