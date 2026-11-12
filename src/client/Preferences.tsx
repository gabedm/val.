import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { CaseSnapshot, PolicyDraft, PolicyFields } from "../shared/contracts.types";
import { api } from "./api";
import { BrandScene } from "./SubscriptionScene";
import {
  confirmedFields,
  conversationLimit,
  openingQuestion,
  preferencePurpose,
  preferenceQuestion,
  type PreferenceTurn,
} from "./preferencesChat";
import { BackLine, capabilityNames, errorText, Icon, pounds, Row } from "./ui";

interface Props {
  snapshot: CaseSnapshot;
  refresh: () => Promise<void>;
  proposal: PolicyFields | null;
  onDone: () => void;
  fresh?: boolean;
}
const checkable = new Set(["MONITORING", "STAY", "NEEDS_REVIEW", "AWAITING_CONSENT"]);

export function Preferences(props: Props) {
  const { snapshot, proposal } = props;
  if (snapshot.receipt.oldBilling === "UNKNOWN" && !snapshot.policy) {
    return (
      <main className="page narrow">
        <BackLine to="home" step="Your preferences" />
        <h1>Finish setup first.</h1>
        <p className="lead">Original service’s paid period must be verified before you set preferences.</p>
      </main>
    );
  }
  if (
    snapshot.policy?.requiredCapabilities.includes("speaker_labels") ||
    proposal?.requiredCapabilities.includes("speaker_labels")
  ) {
    return (
      <main className="page narrow">
        <BackLine to="home" step="Your preferences" />
        <h1>Earlier requirements need review.</h1>
        <p className="lead">
          This case has a saved requirement this version cannot show or change safely. No payment or
          preference was changed. Ask for a separate case review.
        </p>
      </main>
    );
  }
  // A case/revision/proposal change must discard in-flight answers and their old confirmation button.
  return (
    <Conversation
      key={JSON.stringify([snapshot.case.id, snapshot.policy?.revision, proposal, props.fresh])}
      {...props}
    />
  );
}

function PreferenceSummary({ fields }: { fields: PolicyFields }) {
  return (
    <>
      <Row
        label="Required features"
        value={fields.requiredCapabilities.map((capability) => capabilityNames[capability]).join(", ")}
      />
      <Row
        label="Monthly limit"
        value={`${pounds(fields.recurringCeiling.amountMinor)}, including renewal`}
      />
      <Row label="Compare connected plans" value={fields.allowInvestigation ? "Allowed" : "Not allowed"} />
      <Row label="New subscription approval" value="You approve in PayPal" />
    </>
  );
}

/** Measure the reply independently so waiting, errors and real text can share one smoothly resizing bubble. */
function ChatResponse({ children }: { children: ReactNode }) {
  const content = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number>();
  useLayoutEffect(() => {
    const node = content.current!;
    const measure = () => setHeight(node.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="chat-response" style={{ height }}>
      <div ref={content}>{children}</div>
    </div>
  );
}

interface Delivery {
  turns: PreferenceTurn[];
  failed: boolean;
}

/** One live interpretation per answer. Drafting cannot buy, cancel, or save a policy. */
function Conversation({ snapshot, refresh, proposal, onDone, fresh = false }: Props) {
  const baseline = proposal ?? snapshot.policy;
  const [turns, setTurns] = useState<PreferenceTurn[]>([]);
  const [draft, setDraft] = useState<PolicyDraft | null>(null);
  const [answer, setAnswer] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState("");
  const [delivery, setDelivery] = useState<Delivery | null>(null);
  const [saved, setSaved] = useState(false);
  const [unread, setUnread] = useState(false);
  const [useBaseline, setUseBaseline] = useState(!!baseline && !fresh);
  const alive = useRef(true);
  const busy = useRef(false);
  const transcript = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useLayoutEffect(() => {
    const port = transcript.current!;
    // Follow the small height transitions, never the document or a reader who has scrolled back.
    const observer = new ResizeObserver(() => {
      if (follow.current) port.scrollTop = port.scrollHeight;
    });
    observer.observe(content.current!);
    observer.observe(port);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const node = input.current;
    if (!node) return;
    node.style.height = "0px";
    node.style.height = `${Math.min(node.scrollHeight, 144)}px`;
  }, [answer]);
  useEffect(() => {
    if (draft && !follow.current) setUnread(true);
  }, [draft]);
  const legacyPreservation = snapshot.policy?.preserveHistory ?? false;
  const fields = confirmedFields(draft, legacyPreservation);
  const showConfirmation = !!fields && !delivery;
  const visibleTurns = delivery?.turns ?? turns;
  const question =
    turns.length === 0 && baseline && useBaseline
      ? "What would you like to change about these preferences?"
      : preferenceQuestion(draft, legacyPreservation);
  const baselineFields: PolicyFields | null = baseline
    ? {
        purpose: baseline.purpose,
        requiredCapabilities: baseline.requiredCapabilities,
        recurringCeiling: baseline.recurringCeiling,
        preserveHistory: baseline.preserveHistory,
        allowInvestigation: baseline.allowInvestigation,
      }
    : null;

  async function interpret(nextTurns: PreferenceTurn[], clearComposer = true) {
    if (busy.current) return;
    const purpose = preferencePurpose(nextTurns, useBaseline ? baselineFields : null);
    if (purpose.length > conversationLimit) {
      setFailure(
        "This conversation is too long to save safely. Shorten your reply, or start again with a brief description. Your saved preferences haven’t changed.",
      );
      return;
    }
    busy.current = true;
    follow.current = true;
    setPending(true);
    setFailure("");
    setDelivery({ turns: nextTurns, failed: false });
    setUnread(false);
    if (clearComposer) setAnswer("");
    input.current?.focus({ preventScroll: true });
    try {
      const next = await api.draftPolicy(snapshot.case.id, purpose);
      if (!alive.current) return;
      // Retain the exact input reviewed by the API's unsupported-requirement guard.
      setDraft(next);
      setTurns(nextTurns);
      setDelivery(null);
    } catch (error) {
      if (alive.current) {
        setFailure(errorText(error));
        setDelivery({ turns: nextTurns, failed: true });
      }
    } finally {
      busy.current = false;
      if (alive.current) setPending(false);
    }
  }

  function send(event: FormEvent) {
    event.preventDefault();
    if (!answer.trim() || busy.current || saved) return;
    void interpret([...turns, { question, answer: answer.trim() }]);
  }

  async function save() {
    if (!fields || delivery || answer.trim() || busy.current || saved) return;
    busy.current = true;
    setPending(true);
    setFailure("");
    try {
      const policy = await api.putPolicy(snapshot.case.id, fields, snapshot.policy?.revision ?? 0);
      if (!alive.current) return;
      setSaved(true);
      if (policy.allowInvestigation && snapshot.policy && checkable.has(snapshot.case.state))
        await api.check(snapshot.case.id, policy.revision);
      await refresh();
      // Wait for the saved snapshot before leaving, without redirecting a person who opened another case.
      if (
        ["#preferences", "#onboarding"].includes(location.hash) &&
        new URL(location.href).searchParams.get("case") === snapshot.case.id
      )
        onDone();
    } catch (error) {
      if (alive.current) setFailure(errorText(error));
    } finally {
      busy.current = false;
      if (alive.current) setPending(false);
    }
  }

  function restart() {
    if (busy.current || saved) return;
    follow.current = true;
    setTurns([]);
    setDraft(null);
    setAnswer("");
    setFailure("");
    setDelivery(null);
    setUseBaseline(false);
    setUnread(false);
    input.current?.focus({ preventScroll: true });
  }

  return (
    <main className={`page narrow preferences-chat${visibleTurns.length ? " has-replies" : " is-opening"}`}>
      <BackLine to="home" step="Your preferences" />
      <div className="conversation-heading">
        <div className="conversation-motif">
          <div>
            <BrandScene />
          </div>
        </div>
        <h1>
          {visibleTurns.length
            ? "Your preferences"
            : baselineFields && useBaseline
              ? "What would you like to change?"
              : openingQuestion}
        </h1>
      </div>
      {baselineFields && useBaseline && (
        <details className="chat-baseline">
          <summary>{proposal ? "Proposed preferences — not saved" : "Your saved preferences"}</summary>
          <PreferenceSummary fields={baselineFields} />
        </details>
      )}
      <div className="chat-viewport">
        <section
          ref={transcript}
          className="chat-messages"
          tabIndex={0}
          role="log"
          aria-live="polite"
          aria-relevant="additions text"
          aria-label="Conversation with Val"
          onScroll={(event) => {
            const port = event.currentTarget;
            follow.current = port.scrollHeight - port.scrollTop - port.clientHeight < 64;
            if (follow.current) setUnread(false);
          }}
        >
          <div ref={content} className="chat-content">
            {visibleTurns.length > 0 && (
              <p className="chat-message from-val">
                <span className="chat-author">Val</span>
                {baselineFields && useBaseline
                  ? "What would you like to change about these preferences?"
                  : openingQuestion}
              </p>
            )}
            {visibleTurns.map((turn, index) => {
              const last = index === visibleTurns.length - 1;
              const waiting = last && delivery && !delivery.failed;
              const failed = last && delivery?.failed;
              const response = last ? (delivery ? null : question) : visibleTurns[index + 1]!.question;
              return (
                <div className="chat-turn" key={`${index}:${turn.answer}`}>
                  <div className="chat-exchange">
                    <p className="chat-message from-you">
                      <span className="chat-author">You</span>
                      {turn.answer}
                    </p>
                    <ChatResponse>
                      <div className={`chat-message from-val${failed ? " chat-failed" : ""}`}>
                        <span className="chat-author">Val</span>
                        {waiting ? (
                          <div className="chat-wait" role="status">
                            <span className="chat-dots" aria-hidden="true">
                              <i />
                              <i />
                              <i />
                            </span>
                            <span>Considering your reply</span>
                          </div>
                        ) : failed ? (
                          <div className="chat-reply" role="alert">
                            <p>I couldn’t finish that reply. Your message is still here.</p>
                            <div className="chat-error-actions">
                              <button
                                className="text-button"
                                disabled={pending}
                                onClick={() => void interpret(delivery!.turns, false)}
                              >
                                Retry answer
                              </button>
                              <button
                                className="text-button"
                                onClick={() => {
                                  setAnswer(turn.answer);
                                  setDelivery(null);
                                  setFailure("");
                                  input.current?.focus({ preventScroll: true });
                                }}
                              >
                                Edit reply
                              </button>
                            </div>
                          </div>
                        ) : (
                          <p className="chat-reply" key={response}>
                            {response}
                          </p>
                        )}
                      </div>
                    </ChatResponse>
                  </div>
                </div>
              );
            })}
            {!delivery && draft?.unsupportedRequirements.length ? (
              <p className="price-caveat" role="alert">
                Needs Val can’t verify: {draft.unsupportedRequirements.join("; ")}.
              </p>
            ) : null}
            <div
              className={`chat-confirmation${showConfirmation ? " is-visible" : ""}`}
              aria-hidden={!showConfirmation}
              inert={!showConfirmation}
            >
              <div className="chat-confirmation-content">
                {fields && (
                  <section className="form-card" aria-label="Preferences to confirm">
                    <h2>Does this look right?</h2>
                    <PreferenceSummary fields={fields} />
                    <p className="note below">
                      Saving buys nothing. You approve new subscriptions in PayPal and any cancellation
                      separately.
                    </p>
                    <button
                      className="button below"
                      disabled={!showConfirmation || pending || !!answer.trim() || saved}
                      onClick={() => void save()}
                    >
                      {pending && !delivery ? "Saving preferences…" : "Confirm and save preferences"}
                    </button>
                  </section>
                )}
              </div>
            </div>
          </div>
        </section>
        {unread && (
          <button
            className="chat-latest"
            onClick={() => {
              follow.current = true;
              setUnread(false);
              transcript.current?.scrollTo({
                top: transcript.current.scrollHeight,
                behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
              });
            }}
          >
            Latest reply <Icon name="next" />
          </button>
        )}
      </div>
      {!saved && (
        <form className="chat-composer" onSubmit={send}>
          <span className="composer-val" aria-hidden="true">
            v<span>.</span>
          </span>
          <label className="chat-input-label" htmlFor="preference-answer">
            {showConfirmation ? "Anything to change?" : "Your reply"}
          </label>
          <textarea
            ref={input}
            id="preference-answer"
            className="chat-input"
            rows={1}
            maxLength={1000}
            value={answer}
            disabled={pending && !delivery}
            placeholder={showConfirmation ? "Anything to change?" : "Tell Val what matters…"}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                if (!pending) send(event);
              }
            }}
            onChange={(event) => setAnswer(event.target.value)}
          />
          <div className="chat-composer-actions">
            <span className="chat-key-hint">
              {pending ? "You can draft your next reply" : "Enter to send · Shift + Enter for a new line"}
            </span>
            <button
              className="chat-send"
              type="submit"
              aria-label="Send reply"
              disabled={pending || !answer.trim()}
            >
              <Icon name="send" />
            </button>
          </div>
        </form>
      )}
      {failure && !delivery?.failed && (
        <p className="price-caveat below" role="alert">
          {saved ? "Your preferences were saved. The follow-up check could not finish: " : ""}
          {failure}
        </p>
      )}
      {saved && pending && (
        <p className="note below" role="status">
          Checking your updated preferences…
        </p>
      )}
      {saved && (
        <button
          className="button below"
          disabled={pending}
          onClick={() =>
            void refresh()
              .then(onDone)
              .catch((error) => setFailure(errorText(error)))
          }
        >
          Back to your plan
        </button>
      )}
      {!saved && visibleTurns.length > 0 && (
        <button className="text-button chat-restart" disabled={pending} onClick={restart}>
          Start again
        </button>
      )}
    </main>
  );
}
