import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js"
import type {
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js"
import { Effect } from "effect"
import { MCPAuth } from "./oauth"

export const CALLBACK_PORT = 19876
export const CALLBACK_PATH = "/mcp/oauth/callback"

export type Config = {
  readonly clientId?: string
  readonly clientSecret?: string
  readonly scope?: string
  readonly callbackPort?: number
  readonly redirectUri?: string
}

export class Provider implements OAuthClientProvider {
  constructor(
    protected readonly name: string,
    protected readonly serverUrl: string,
    protected readonly config: Config,
    private readonly redirect: (url: URL) => void | Promise<void>,
    protected readonly auth: MCPAuth.Interface,
  ) {}

  get redirectUrl() {
    return (
      this.config.redirectUri ??
      `http://127.0.0.1:${this.config.callbackPort ?? CALLBACK_PORT}${CALLBACK_PATH}`
    )
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl],
      client_name: "OpenCode",
      client_uri: "https://opencode.ai",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.config.clientSecret ? "client_secret_post" : "none",
      ...(this.config.scope ? { scope: this.config.scope } : {}),
    }
  }

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    if (this.config.clientId)
      return { client_id: this.config.clientId, client_secret: this.config.clientSecret }
    const entry = await Effect.runPromise(this.auth.getForUrl(this.name, this.serverUrl))
    if (!entry?.clientInfo) return
    if (entry.clientInfo.clientSecretExpiresAt && entry.clientInfo.clientSecretExpiresAt < Date.now() / 1000) return
    return { client_id: entry.clientInfo.clientId, client_secret: entry.clientInfo.clientSecret }
  }

  async saveClientInformation(info: OAuthClientInformationFull) {
    await Effect.runPromise(
      this.auth.updateClientInfo(
        this.name,
        {
          clientId: info.client_id,
          clientSecret: info.client_secret,
          clientIdIssuedAt: info.client_id_issued_at,
          clientSecretExpiresAt: info.client_secret_expires_at,
        },
        this.serverUrl,
      ),
    )
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const entry = await Effect.runPromise(this.auth.getForUrl(this.name, this.serverUrl))
    if (!entry?.tokens) return
    return {
      access_token: entry.tokens.accessToken,
      token_type: "Bearer",
      refresh_token: entry.tokens.refreshToken,
      expires_in: entry.tokens.expiresAt
        ? Math.max(0, Math.floor(entry.tokens.expiresAt - Date.now() / 1000))
        : undefined,
      scope: entry.tokens.scope,
    }
  }

  async saveTokens(tokens: OAuthTokens) {
    await Effect.runPromise(
      this.auth.updateTokens(
        this.name,
        {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresAt: tokens.expires_in ? Date.now() / 1000 + tokens.expires_in : undefined,
          scope: tokens.scope,
        },
        this.serverUrl,
      ),
    )
  }

  async redirectToAuthorization(url: URL) {
    await this.redirect(url)
  }

  async saveCodeVerifier(verifier: string) {
    await Effect.runPromise(this.auth.updateCodeVerifier(this.name, verifier))
  }

  async codeVerifier() {
    const verifier = (await Effect.runPromise(this.auth.get(this.name)))?.codeVerifier
    if (!verifier) throw new Error(`No code verifier saved for MCP server: ${this.name}`)
    return verifier
  }

  async saveState(state: string) {
    await Effect.runPromise(this.auth.updateOAuthState(this.name, state))
  }

  async state() {
    const stored = (await Effect.runPromise(this.auth.get(this.name)))?.oauthState
    if (stored) return stored
    const state = crypto.getRandomValues(new Uint8Array(32)).toHex()
    await Effect.runPromise(this.auth.updateOAuthState(this.name, state))
    return state
  }

  async invalidateCredentials(type: "all" | "client" | "tokens") {
    const entry = await Effect.runPromise(this.auth.get(this.name))
    if (!entry) return
    if (type === "all") return Effect.runPromise(this.auth.remove(this.name))
    if (type === "client") delete entry.clientInfo
    if (type === "tokens") delete entry.tokens
    await Effect.runPromise(this.auth.set(this.name, entry, this.serverUrl))
  }
}

export class PendingProvider extends Provider {
  private info?: OAuthClientInformationFull
  private token?: OAuthTokens

  override async clientInformation() {
    if (this.config.clientId)
      return { client_id: this.config.clientId, client_secret: this.config.clientSecret }
    return this.info
  }
  override async saveClientInformation(info: OAuthClientInformationFull) {
    this.info = info
  }
  override async tokens() {
    return this.token
  }
  override async saveTokens(token: OAuthTokens) {
    this.token = token
  }
  override async invalidateCredentials(type: "all" | "client" | "tokens") {
    if (type !== "tokens") this.info = undefined
    if (type !== "client") this.token = undefined
  }
  async commit() {
    if (!this.token) return
    await this.saveCommitted(this.token, this.info)
  }

  private async saveCommitted(token: OAuthTokens, info?: OAuthClientInformationFull) {
    await Effect.runPromise(
      this.auth.set(
        this.name,
        {
          tokens: {
            accessToken: token.access_token,
            refreshToken: token.refresh_token,
            expiresAt: token.expires_in ? Date.now() / 1000 + token.expires_in : undefined,
            scope: token.scope,
          },
          clientInfo:
            info && !this.config.clientId
              ? {
                  clientId: info.client_id,
                  clientSecret: info.client_secret,
                  clientIdIssuedAt: info.client_id_issued_at,
                  clientSecretExpiresAt: info.client_secret_expires_at,
                }
              : undefined,
        },
        this.serverUrl,
      ),
    )
  }
}
