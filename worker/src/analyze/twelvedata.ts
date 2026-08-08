/**
 * @deprecated Re-export from new provider location.
 * Будет удалён после миграции analyze/job.ts на providers/ (PR-3).
 */
export {
  TwelveDataError,
  TwelveDataQuotaError,
  TwelveDataProvider,
  fetchTimeSeries,
} from "./providers/twelvedata";
export type { FetchResult } from "./providers/types";
