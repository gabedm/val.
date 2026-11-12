import { subscriptionAdviceFormat } from "../shared/subscriptions";
import { HttpError } from "./http";

export function requireCurrentComparisonView(format: string | undefined) {
  if (format !== subscriptionAdviceFormat)
    throw new HttpError(
      426,
      "client_update_required",
      "Val has been updated. Refresh this page to load accurate payment details. Your saved answers are safe.",
    );
}
