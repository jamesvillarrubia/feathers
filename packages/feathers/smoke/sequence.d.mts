export const SMOKE_USER: { email: string; password: string }
export const SMOKE_API_KEY: string
export function runSmoke(call: (path: string, init?: RequestInit) => Promise<Response>): Promise<string>
