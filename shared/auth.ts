// Public status only. Never add the authorization URL, code, verifier or API key here.
export interface TokenDanceAuthStatus {
  phase: 'idle' | 'starting' | 'waiting' | 'exchanging' | 'success' | 'cancelled' | 'error';
  message: string;
  expiresAt?: number;
}
export const TOKENDANCE_GATEWAY = 'https://tokendance.space/gateway';
export const TOKENDANCE_AUTH_DOCS = 'https://tokendance.space/docs/api-key-oauth';
