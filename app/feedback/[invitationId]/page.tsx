'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Check, Loader2, Star } from 'lucide-react';

type Question = {
  key: string;
  type: 'rating' | 'text';
  required: boolean;
  label: string;
};

const defaultQuestions: Question[] = [
  { key: 'rating', type: 'rating', required: true, label: 'Overall experience' },
  { key: 'comment', type: 'text', required: false, label: 'Written comment' },
];

export default function FeedbackInvitationPage() {
  const params = useParams<{ invitationId: string }>();
  const id = params.invitationId;
  const [restaurant, setRestaurant] = useState('Restaurant');
  const [questions, setQuestions] = useState<Question[]>(defaultQuestions);
  const [rating, setRating] = useState(0);
  const [answers, setAnswers] = useState<Record<string, number | string>>({});
  const [reviewUrl, setReviewUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void fetch(`/api/public-feedback/${id}`, { cache: 'no-store' })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'This feedback link is unavailable.');
        if (!active) return;
        setRestaurant(result.restaurantName);
        setQuestions(Array.isArray(result.questions) ? result.questions : defaultQuestions);
        setReviewUrl(typeof result.reviewUrl === 'string' ? result.reviewUrl : null);
        setDone(result.submitted);
      })
      .catch((loadError: unknown) => {
        if (active) setError(loadError instanceof Error ? loadError.message : 'Could not load feedback.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [id]);

  async function submit() {
    if (rating < 1) {
      setError('Choose an overall experience rating to continue.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/public-feedback/${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rating, comment: answers.comment ?? '', answers }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not submit feedback.');
      if (typeof result.reviewUrl === 'string') setReviewUrl(result.reviewUrl);
      setDone(true);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Could not submit feedback.');
    } finally {
      setBusy(false);
    }
  }

  function renderRatingQuestion(question: Question) {
    const selected = question.key === 'rating' ? rating : Number(answers[question.key] ?? 0);
    return <fieldset key={question.key} className="public-feedback-question">
      <legend>{question.label}{question.required ? ' *' : ''}</legend>
      <div className="public-feedback-stars" role="radiogroup" aria-label={question.label}>
        {[1, 2, 3, 4, 5].map((value) => <button
          type="button"
          role="radio"
          aria-checked={selected === value}
          key={value}
          aria-label={`${value} out of 5`}
          onClick={() => question.key === 'rating'
            ? setRating(value)
            : setAnswers((current) => ({ ...current, [question.key]: value }))}
        >
          <Star fill={selected >= value ? 'currentColor' : 'none'} size={30} />
        </button>)}
      </div>
    </fieldset>;
  }

  return <main className="public-feedback-page">
    <section className="public-feedback-card">
      <span className="eyebrow">CUSTOMER FEEDBACK</span>
      <h1>{restaurant}</h1>
      {loading ? <Loader2 className="spin" /> : done ? <>
        <div className="notice notice-success"><Check size={16} /> Thank you for sharing your private feedback.</div>
        {reviewUrl ? <p className="public-feedback-review-link">Your optional Google review is also welcome: <a href={reviewUrl} target="_blank" rel="noreferrer">View the restaurant’s Google review page</a>.</p> : null}
      </> : <>
        <p>Your honest experience helps the restaurant improve. This feedback is private to the restaurant and is separate from public Google reviews.</p>
        {questions.map((question) => question.type === 'rating'
          ? renderRatingQuestion(question)
          : <label className="public-feedback-question" key={question.key}>{question.label}{question.required ? ' *' : ''}
            <textarea
              value={String(answers[question.key] ?? '')}
              onChange={(event) => setAnswers((current) => ({ ...current, [question.key]: event.target.value }))}
              maxLength={5000}
              rows={5}
              placeholder="Optional private feedback"
              required={question.required}
            />
          </label>)}
        <button type="button" className="button button-primary" onClick={() => void submit()} disabled={busy || rating === 0}>
          {busy ? <><Loader2 size={15} className="spin" /> Submitting…</> : 'Send private feedback'}
        </button>
        {reviewUrl ? <p className="public-feedback-review-link">You may also leave a voluntary Google review, regardless of your private feedback: <a href={reviewUrl} target="_blank" rel="noreferrer">View the restaurant’s Google review page</a>.</p> : null}
      </>}
      {error ? <div className="notice notice-error" role="alert">{error}</div> : null}
    </section>
  </main>;
}
