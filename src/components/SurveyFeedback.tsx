import { useState } from "react";
import { EyeOff, Loader2, ShieldCheck } from "lucide-react";
import type { WalletConnectionState } from "../lib/wallet";
import type { SubmissionState } from "../hooks/useMidnight";
import { ERA_LABEL } from "../lib/midnight/era.js";
import { StatusMessage } from "./StatusMessage";

interface SurveyFeedbackProps {
  wallet: WalletConnectionState;
  submission: SubmissionState;
  onSubmit: (rating: number, comment: string) => void;
}

const RATING_LABELS = ["Very dissatisfied", "Dissatisfied", "Neutral", "Satisfied", "Very satisfied"];

export function SurveyFeedback({ wallet, submission, onSubmit }: SurveyFeedbackProps) {
  const [rating, setRating] = useState<number | null>(null);
  const [comment, setComment] = useState("");

  const isConnected = wallet.status === "connected";
  const isBusy = submission.stage === "generating-proof" || submission.stage === "submitting";
  const isDone = submission.stage === "confirmed";

  return (
    <section className="card">
      <h2>How was your onboarding experience?</h2>
      <p className="card-subtitle">
        Your response is anonymous. The network can confirm that an eligible respondent submitted it and
        cannot link it back to you.
      </p>

      <fieldset className="rating-group" disabled={!isConnected || isBusy || isDone}>
        <legend>Rating</legend>
        <div className="rating-scale">
          {RATING_LABELS.map((label, index) => {
            const value = index + 1;
            return (
              <button
                key={value}
                type="button"
                className={`rating-button${rating === value ? " rating-button-selected" : ""}`}
                onClick={() => setRating(value)}
                aria-pressed={rating === value}
              >
                <span className="rating-value">{value}</span>
                <span className="rating-label">{label}</span>
              </button>
            );
          })}
        </div>
      </fieldset>

      <label className="field">
        <span className="field-label">
          Comments <span className="field-optional">(optional, never leaves your browser)</span>
        </span>
        <textarea
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          disabled={!isConnected || isBusy || isDone}
          placeholder="Anything specific you'd like the team to know?"
          rows={4}
        />
      </label>

      <div className="disclosure-note">
        <EyeOff size={14} aria-hidden="true" />
        <span>Proved without revealing your identity, and without revealing your comment on-chain.</span>
      </div>

      {!isConnected && (
        <StatusMessage kind="info">Connect 1AM Wallet above to submit feedback.</StatusMessage>
      )}

      {submission.stage === "generating-proof" && (
        <StatusMessage kind="pending">Generating your zero-knowledge proof locally...</StatusMessage>
      )}
      {submission.stage === "submitting" && (
        <StatusMessage kind="pending">Submitting your transaction to the {ERA_LABEL.includes("Preview") ? "Preview" : "Preprod"} network...</StatusMessage>
      )}
      {submission.stage === "confirmed" && (
        <StatusMessage kind="success">
          <span className="confirmed-message">
            <ShieldCheck size={16} aria-hidden="true" /> Feedback recorded. The public tally has been
            updated; your identity and your comment were not.
          </span>
        </StatusMessage>
      )}
      {submission.stage === "failed" && (
        <StatusMessage kind="error">{submission.error ?? "Something went wrong."}</StatusMessage>
      )}

      <button
        type="button"
        className="button button-primary"
        disabled={!isConnected || rating === null || isBusy || isDone}
        onClick={() => rating !== null && onSubmit(rating, comment)}
      >
        {isBusy ? (
          <>
            <Loader2 size={16} className="spin" aria-hidden="true" /> Working...
          </>
        ) : isDone ? (
          "Submitted"
        ) : (
          "Submit feedback"
        )}
      </button>
    </section>
  );
}
