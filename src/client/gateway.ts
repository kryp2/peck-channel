/**
 * peck-channel — gateway HTTP client.
 *
 * Thin, dependency-free wrapper over the peck.channel gateway HTTP contract
 * (see ../../PECK_CHANNEL_SPEC.md §4). peck-host (peck.run) is the reference
 * implementation; any gateway honoring the same routes is a drop-in consumer.
 *
 * The client only ever SENDS data (channel state, sighashes, signed txs). It never
 * holds or transmits a private key — the non-custodial invariant. The user's
 * signature comes from their BRC-100 wallet; the gateway co-signs + fee-signs and
 * broadcasts server-side.
 */

export interface GatewayResponse<T = any> {
  ok: boolean
  status: number
  json: T | null
  text: string
}

export interface OpenChannelRequest {
  channel_txid: string
  amount: number
  script_hex: string
  satoshi_value: number
  vout: number
  user_pubkey: string
  expiry_time?: number
  /** Gateway fee-fund UTXO so the gateway can sign the fee input itself (non-custodial). */
  fee_txid?: string
  fee_vout?: number
  fee_satoshi_value?: number
}

export interface RequestDrainResult {
  drain_amount: number
  nonce: number
  /** Gateway sig over a PLACEHOLDER sighash — re-fetch the real one via cosignDrain. */
  gateway_sig?: string
  sighash?: string
  sighash_flag?: number
  lock_amount?: number
  amount_spent?: number
  error?: string
}

export interface CosignDrainResult {
  gateway_sig: string
  sighash_flag?: number
  error?: string
}

export interface SubmitDrainResult {
  status?: string
  txid?: string
  error?: string
}

/**
 * HTTP client for a peck.channel gateway. Construct with the gateway base URL and
 * the caller's identity pubkey (sent as `Authorization: Bearer <pubkey>`).
 */
export class PeckChannelGateway {
  constructor(private baseUrl: string, private authPubKey: string = '') {}

  /** Set/replace the bearer identity (e.g. after deriving the wallet child pubkey). */
  setAuthPubKey(pubKey: string): void {
    this.authPubKey = pubKey
  }

  private async post<T = any>(path: string, body: any): Promise<GatewayResponse<T>> {
    const res = await fetch(this.baseUrl + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + this.authPubKey },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    let json: any = null
    try {
      json = JSON.parse(text)
    } catch {
      /* non-JSON body — keep text */
    }
    return { ok: res.ok, status: res.status, json, text }
  }

  /** Liveness probe (no auth required). */
  async health(): Promise<{ ok: boolean; status: number; body: string }> {
    const res = await fetch(this.baseUrl + '/health')
    return { ok: res.ok, status: res.status, body: await res.text() }
  }

  /** Register a deployed channel so the gateway can provision its drain state. */
  open(req: OpenChannelRequest): Promise<GatewayResponse> {
    return this.post('/api/channels/open', req)
  }

  /** Ask the gateway for the pending drain amount/nonce (it also returns a placeholder sig). */
  requestDrain(channelTxid: string): Promise<GatewayResponse<RequestDrainResult>> {
    return this.post('/api/channels/drain', { channel_txid: channelTxid })
  }

  /** Have the gateway co-sign the client's REAL next-state sighash (the production path). */
  cosignDrain(channelTxid: string, sighashHex: string): Promise<GatewayResponse<CosignDrainResult>> {
    return this.post('/api/channels/cosign-drain', { channel_txid: channelTxid, sighash_hex: sighashHex })
  }

  /** Post the finished drain tx; the gateway fee-signs input[1], verifies, and broadcasts via ARC. */
  submitDrain(channelTxid: string, signedTxHex: string): Promise<GatewayResponse<SubmitDrainResult>> {
    return this.post('/api/channels/submit-drain', { channel_txid: channelTxid, signed_tx_hex: signedTxHex })
  }

  /**
   * DEV/TEST ONLY — set PendingDrain directly without the metering loop. Requires the
   * gateway started with PECKHOST_ALLOW_ACCRUE=1. In production the per-second/per-token
   * meter accrues PendingDrain; real consumers never call this.
   */
  accrueDrain(channelTxid: string, amountSats: number): Promise<GatewayResponse> {
    return this.post('/api/channels/accrue-drain', { channel_txid: channelTxid, amount_sats: amountSats })
  }
}
