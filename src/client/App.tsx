import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CaseSummary, PolicyFields, SessionView } from "../shared/contracts.types";
import { Activity, Account } from "./Activity";
import { api } from "./api";
import { CatalogueBrowser, ServiceDetail } from "./Discover";
import { Home } from "./Home";
import { Options } from "./Options";
import { Recovery, ReviewSwitch } from "./Purchase";
import { Preferences } from "./Preferences";
import { ReturnBridge } from "./ReturnBridge";
import { Launch, SessionArrival, SignIn, useSession } from "./SessionPanel";
import { entryMarker, introDuration, introExitDuration } from "./startup";
import {
  activeProductTab,
  chatTarget,
  isPaymentRoute,
  mainTabs,
  productRoute,
  subscriptionTarget,
} from "./navigation";
import { SavedSetupPayment } from "./SavedSetupPayment";
import { portfolioSummary, type PortfolioIngestion } from "./portfolio-progress";
import { readOnboardingProgress } from "./onboarding-progress";
import { ReviewTools } from "./Tools";
import { Icon, go, useCaseSnapshot } from "./ui";
import { Subscriptions, usePortfolio, type PortfolioData } from "./Subscriptions";
import { SubscriptionDetail } from "./SubscriptionDetail";
import { SubscriptionSwitch } from "./SubscriptionSwitch";
import { SwitchExample } from "./SwitchExample";
import { switchTarget } from "./navigation";
import { PayPalSubscriptionChat as SubscriptionChat } from "./PayPalIngestion";
import { SubscriptionActivity } from "./SubscriptionActivity";
import type { SubscriptionPortfolio } from "../shared/subscriptions";
import { JudgeAccess } from "./JudgeAccess";
import { DeploymentContext, useDeployment } from "./deployment";
import type { DeploymentCapabilities } from "../shared/deployment";

export function App() {
  const [deployment, setDeployment] = useState<DeploymentCapabilities | null>(null);
  const [failure, setFailure] = useState("");
  const load = useCallback(async () => {
    setFailure("");
    try {
      setDeployment(await api.deployment());
    } catch {
      setFailure("Val couldn’t open just now. Please try again.");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useLayoutEffect(() => {
    document.documentElement.classList.remove("app-starting");
  }, []);
  if (!deployment) return <SessionArrival failure={failure} onRetry={() => void load()} />;
  return (
    <DeploymentContext value={deployment}>
      <JudgeAccess>
        {deployment.financialTools && location.pathname.startsWith("/paypal/") ? (
          <ReturnBridge />
        ) : (
          <Product />
        )}
      </JudgeAccess>
    </DeploymentContext>
  );
}

function useRoute(admin: boolean, freshOnboarding: boolean) {
  const { financialTools } = useDeployment();
  const read = (initial = false) => {
    const url = new URL(location.href);
    const route = productRoute(
      url.hash.slice(1),
      url.searchParams.get("case"),
      admin,
      !financialTools,
      initial && freshOnboarding,
    );
    if (!isPaymentRoute(route) && route !== "tools") url.searchParams.delete("case");
    url.hash = route;
    if (url.href !== location.href) history.replaceState(null, "", url);
    return route;
  };
  // Boot into Val unless the user explicitly opened another destination. Saved purposes never select a tab.
  const [route, setRoute] = useState(() => read(true));
  const previousRoute = useRef(route);
  useEffect(() => {
    const onChange = () => setRoute(read());
    addEventListener("hashchange", onChange);
    return () => removeEventListener("hashchange", onChange);
  }, []);
  useEffect(() => {
    window.scrollTo(0, 0);
    if (previousRoute.current === route) return;
    previousRoute.current = route;
    const heading = document.querySelector<HTMLElement>(".route-view:not([hidden]) main h1");
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
  }, [route]);
  return route;
}

function Masthead() {
  return (
    <header className="masthead">
      <button className="wordmark" onClick={() => go("home")} aria-label="Val home">
        val.
      </button>
    </header>
  );
}

function Product() {
  const [session, setSession, failure, refreshSession] = useSession();
  const [startWithOnboarding] = useState(
    () =>
      new URLSearchParams(location.search).get("start") === "onboarding" ||
      entryMarker("val-entry-next") === "onboarding",
  );
  const [direct] = useState(
    () =>
      (!startWithOnboarding && !!location.hash && !["#home", "#welcome"].includes(location.hash)) ||
      (entryMarker("val-login-pending") === "1" && !new URLSearchParams(location.search).has("login")),
  );
  const [introDone, setIntroDone] = useState(
    () => direct || window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [introReady, setIntroReady] = useState(introDone);
  const [introExiting, setIntroExiting] = useState(false);
  const [entered, setEntered] = useState(direct);
  useEffect(() => {
    // Restore the destination without cutting short the opening artwork.
    if (session?.authenticated && location.hash !== "#welcome") {
      setEntered(true);
    }
  }, [session?.authenticated]);
  const portfolio = usePortfolio(session?.authenticated ? (session.ownerId ?? undefined) : undefined);
  useEffect(() => {
    if (introDone || introReady) return;
    const timer = setTimeout(() => setIntroReady(true), introDuration - introExitDuration);
    return () => clearTimeout(timer);
  }, [introDone, introReady]);
  const sessionReady = !!session;
  useEffect(() => {
    // Slow identity checks hold the settled artwork; fast checks still finish the full animation.
    if (introDone || !introReady || !sessionReady) return;
    setIntroExiting(true);
    const timer = setTimeout(() => setIntroDone(true), introExitDuration);
    return () => clearTimeout(timer);
  }, [introDone, introReady, sessionReady]);
  useEffect(() => {
    if (!session || !introDone) return;
    if ((entered && session.authenticated) || !session.authenticated) entryMarker("val-login-pending", null);
    if (entered && session.authenticated) entryMarker("val-entry-next", null);
  }, [session, entered, introDone]);
  const enter = (next: SessionView) => {
    setSession(next);
    setEntered(next.authenticated);
  };
  if (direct && !session) return <SessionArrival failure={failure} onRetry={() => void refreshSession()} />;
  if (!introDone || !session)
    return (
      <Launch
        intro={!introDone}
        exiting={introExiting}
        failure={failure}
        onRetry={() => void refreshSession()}
      />
    );
  if (session.authenticated && entered) {
    if (!portfolio.data) return <SessionArrival failure={portfolio.failure} onRetry={portfolio.load} />;
    return (
      <Signed
        session={session}
        onSession={enter}
        startWithOnboarding={startWithOnboarding}
        portfolio={{ ...portfolio, data: portfolio.data }}
        key={session.ownerId}
      />
    );
  }
  return (
    <SignIn
      onSession={enter}
      existingSession={session.authenticated ? session : undefined}
      startWithOnboarding={startWithOnboarding}
    />
  );
}

function Signed({
  session,
  onSession,
  startWithOnboarding,
  portfolio,
}: {
  session: SessionView;
  onSession: (session: SessionView) => void;
  startWithOnboarding: boolean;
  portfolio: { data: PortfolioData; update: (portfolio: SubscriptionPortfolio) => void; load: () => void };
}) {
  const [resumedOnboarding] = useState(() =>
    startWithOnboarding && session.ownerId ? readOnboardingProgress(portfolio.data.portfolio) : null,
  );
  const [freshNeeds, setFreshNeeds] = useState(startWithOnboarding && !resumedOnboarding?.complete);
  const { financialTools } = useDeployment();
  const admin = session.role === "admin";
  const route = useRoute(admin, freshNeeds);
  const paymentRoute = isPaymentRoute(route);
  const chatVisible = route === "home" || route.startsWith("val/");
  const [ingestion, setIngestion] = useState<PortfolioIngestion | null>(() =>
    chatVisible ? { phase: "finding", subscriptions: [] } : null,
  );
  const [confirmedNeeds, setConfirmedNeeds] = useState<string[]>(resumedOnboarding?.confirmed ?? []);
  const onIngestion = useCallback((progress: PortfolioIngestion) => setIngestion(progress), []);
  const onMemoryConfirmed = useCallback(
    (id: string) => setConfirmedNeeds((previous) => (previous.includes(id) ? previous : [...previous, id])),
    [],
  );
  const summary = portfolioSummary(portfolio.data.portfolio, ingestion, freshNeeds, confirmedNeeds);
  const finding = ingestion?.phase === "finding";
  const ingestionFailed = ingestion?.phase === "failed";
  const remainingPurposeIds = freshNeeds
    ? portfolio.data.portfolio.subscriptions
        .filter((row) => !confirmedNeeds.includes(row.serviceId))
        .map((row) => row.serviceId)
    : [];
  const [chatRoute, setChatRoute] = useState<string | null>(chatVisible ? route : null);
  useLayoutEffect(() => {
    if (chatVisible) setChatRoute(route);
  }, [chatVisible, route]);
  const firstRoute = useRef<string | null>(route);
  useEffect(() => {
    if (route !== firstRoute.current) firstRoute.current = null;
  }, [route]);
  const [cases, setCases] = useState<CaseSummary[] | null>(null);
  const [casesFailure, setCasesFailure] = useState("");
  const [caseId, setCaseId] = useState(new URLSearchParams(location.search).get("case"));
  const [proposal, setProposal] = useState<PolicyFields | null>(null);
  // Ordinary portfolio pages neither depend on nor poll retired review cases.
  const { snapshot, failure, refresh } = useCaseSnapshot(
    paymentRoute || route === "tools" || route === "activity" ? caseId : null,
  );
  const firstScreenFocused = useRef(false);
  useEffect(() => {
    if (firstScreenFocused.current || (paymentRoute && caseId && !snapshot)) return;
    firstScreenFocused.current = true;
    const heading = document.querySelector<HTMLElement>(".route-view:not([hidden]) main h1");
    if (heading && document.activeElement === document.body) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
  }, [paymentRoute, caseId, snapshot]);
  useEffect(() => {
    const sync = () => {
      if (isPaymentRoute(location.hash.slice(1)) || location.hash === "#tools")
        setCaseId(new URLSearchParams(location.search).get("case"));
    };
    sync();
    addEventListener("hashchange", sync);
    addEventListener("popstate", sync);
    return () => {
      removeEventListener("hashchange", sync);
      removeEventListener("popstate", sync);
    };
  }, [route, paymentRoute]);
  const choose = (id: string | null) => {
    setCaseId(id);
    const url = new URL(location.href);
    if (id) url.searchParams.set("case", id);
    else url.searchParams.delete("case");
    history.replaceState(null, "", url);
  };
  const refreshCases = async () => {
    setCasesFailure("");
    try {
      const list = await api.cases();
      setCases(list);
      return list;
    } catch (error) {
      setCasesFailure(error instanceof Error ? error.message : "Your activity could not be loaded.");
      return null;
    }
  };
  useEffect(() => {
    if ((route === "activity" && financialTools) || route === "tools") void refreshCases();
  }, [route, financialTools]);

  const open = async (id: string, to = "case") => {
    choose(id);
    await refreshCases();
    go(to);
  };
  const caseProps = snapshot?.case.id === caseId ? { snapshot, refresh } : null;

  let screen;
  if (route === "home" || route === "subscriptions" || route.startsWith("val/")) {
    screen =
      route === "subscriptions" ? (
        <Subscriptions
          data={{ ...portfolio.data, portfolio: summary }}
          ownerId={session.ownerId!}
          onReload={portfolio.load}
          finding={finding}
          ingestionFailed={ingestionFailed}
        />
      ) : null;
  } else if (route === "switch-example") screen = <SwitchExample portfolio={portfolio.data.portfolio} />;
  else if (switchTarget(route))
    screen = <SubscriptionSwitch id={switchTarget(route)!} onReload={portfolio.load} />;
  else if (subscriptionTarget(route))
    screen = (
      <SubscriptionDetail
        id={subscriptionTarget(route)!}
        data={{ ...portfolio.data, portfolio: summary }}
        ownerId={session.ownerId!}
        onReload={portfolio.load}
      />
    );
  else if (route === "browse") screen = <CatalogueBrowser data={portfolio.data.catalogue} />;
  else if (route.startsWith("service/")) screen = <ServiceDetail id={route.slice("service/".length)} />;
  else if (route === "activity")
    screen = (
      <SubscriptionActivity
        data={{ ...portfolio.data, portfolio: summary }}
        ownerId={session.ownerId!}
        onReload={portfolio.load}
        legacy={
          financialTools && cases?.some((row) => row.state !== "SETUP") ? (
            <Activity embedded cases={cases} selected={caseId} snapshot={snapshot} onOpen={open} />
          ) : undefined
        }
      />
    );
  else if (route === "account")
    screen = <Account session={session} onSession={onSession} onPortfolio={portfolio.update} />;
  else if (route === "tools" && admin)
    screen = (
      <ReviewTools caseId={caseId} snapshot={snapshot} refresh={refresh} onCreated={(id) => open(id)} />
    );
  else if (!caseProps)
    screen = (
      <main className="page narrow has-nav">
        <h1>Saved payment</h1>
        {failure ? (
          <>
            <p role="alert">{failure}</p>
            <button className="button below" onClick={() => void refresh()}>
              Try again
            </button>
          </>
        ) : (
          <p role="status">Loading payment status…</p>
        )}
        <button className="text-button below" onClick={() => go("activity")}>
          Back to activity
        </button>
      </main>
    );
  else if (caseProps.snapshot.case.state === "SETUP") screen = <SavedSetupPayment {...caseProps} />;
  else if (route === "preferences")
    screen = (
      <Preferences
        {...caseProps}
        proposal={proposal}
        onDone={() => {
          setProposal(null);
          go("case");
        }}
      />
    );
  else if (route === "options")
    screen = (
      <Options
        {...caseProps}
        onPropose={(fields) => {
          setProposal(fields);
          go("preferences");
        }}
      />
    );
  else if (route === "review") screen = <ReviewSwitch {...caseProps} />;
  else if (route === "recovery") screen = <Recovery {...caseProps} />;
  else screen = <Home snapshot={snapshot} failure={failure} loading={false} refresh={refresh} />;

  const activeTab = activeProductTab(route);
  return (
    <div className="shell signed-arrival">
      <Masthead />
      {casesFailure && ["activity", "tools"].includes(route) && (
        <section className="page narrow" role="alert">
          <p className="note">{casesFailure}</p>
          <button className="button below" onClick={() => void refreshCases()}>
            Try again
          </button>
        </section>
      )}
      {chatRoute !== null && (
        <div
          className={`route-view${chatRoute === firstRoute.current ? " initial-route" : ""}`}
          hidden={!chatVisible}
        >
          <SubscriptionChat
            data={portfolio.data}
            onUpdate={portfolio.update}
            initialServiceId={chatTarget(chatRoute)?.serviceId}
            initialIntent={chatTarget(chatRoute)?.intent}
            active={chatVisible}
            freshStart={freshNeeds}
            remainingPurposeIds={remainingPurposeIds}
            onMemoryConfirmed={onMemoryConfirmed}
            onIngestion={onIngestion}
            onSetupComplete={() => setFreshNeeds(false)}
          />
        </div>
      )}
      {!chatVisible && (
        <div className={`route-view${route === firstRoute.current ? " initial-route" : ""}`} key={route}>
          {screen}
        </div>
      )}
      {activeTab && (
        <nav
          className="footer-nav"
          aria-label="Main navigation"
          style={{ "--tab-index": mainTabs.findIndex(([id]) => id === activeTab) } as React.CSSProperties}
        >
          {mainTabs.map(([id, label, glyph]) => (
            <button
              key={id}
              className={`nav-item ${id === activeTab ? "active" : ""}`}
              aria-current={id === activeTab ? "page" : undefined}
              onClick={() => go(id)}
            >
              <Icon name={glyph} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}
