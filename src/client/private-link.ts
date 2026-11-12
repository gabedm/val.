let captured: { token: string; redemption?: Promise<{ allowed: boolean }> } | null = null;

/** Fragments stay out of HTTP URLs; remove the reusable secret before entering the product. */
export function capturePrivateLink(location: Location, history: Pick<History, "replaceState">) {
  if (location.hash.startsWith("#access=")) {
    const token = location.hash.slice(8);
    captured = { token: /^[A-Za-z0-9_-]{43}$/.test(token) ? token : "" };
    history.replaceState(null, "", location.pathname + location.search + "#home");
  }
  return captured;
}

/** StrictMode and retries reuse the same redemption rather than racing bootstrap cookies. */
export function redeemPrivateLink(
  link: NonNullable<ReturnType<typeof capturePrivateLink>>,
  session: () => Promise<unknown>,
  redeem: (access: string) => Promise<{ allowed: boolean }>,
) {
  if (!link.redemption)
    link.redemption = session()
      .then(() => redeem(link.token))
      .then((result) => {
        link.token = "";
        if (captured === link) captured = null;
        return result;
      })
      .catch((error) => {
        link.redemption = undefined;
        throw error;
      });
  return link.redemption;
}
