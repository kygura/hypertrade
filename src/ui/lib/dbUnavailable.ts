/** The reason the server states (503) when no database is configured; see failure() in server/routes/intel/http.ts. */
export const isDbUnavailable = (message: string | null | undefined): message is string => !!message && message.includes('DATABASE_URL is not set')
