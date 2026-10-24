'use client';

import { useEffect, useState } from 'react';

type QuestionKey = 'rating' | 'food_quality' | 'service_quality' | 'cleanliness' | 'waiting_time' | 'value_for_money' | 'comment';
type Question = { key: QuestionKey; type: 'rating' | 'text'; required: boolean };

const choices: Array<{ key: QuestionKey; type: Question['type']; label: string }> = [
  { key: 'rating', type: 'rating', label: 'Overall experience (required)' },
  { key: 'food_quality', type: 'rating', label: 'Food quality' },
  { key: 'service_quality', type: 'rating', label: 'Service quality' },
  { key: 'cleanliness', type: 'rating', label: 'Cleanliness' },
  { key: 'waiting_time', type: 'rating', label: 'Waiting time' },
  { key: 'value_for_money', type: 'rating', label: 'Value for money' },
  { key: 'comment', type: 'text', label: 'Written comment' },
];

const defaultQuestions: Question[] = [
  { key: 'rating', type: 'rating', required: true },
  { key: 'comment', type: 'text', required: false },
];

export function FeedbackQuestionSettings() {
  const [questions, setQuestions] = useState<Question[]>(defaultQuestions);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let active = true;
    void fetch('/api/engagement', { cache: 'no-store' })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Could not load feedback questions.');
        const configured = result.feedbackSettings?.questions;
        if (active && Array.isArray(configured)) {
          const allowed = new Set(choices.map((choice) => choice.key));
          const filtered = configured.filter((question: Question) => question && allowed.has(question.key));
          setQuestions(filtered.some((question: Question) => question.key === 'rating')
            ? filtered
            : defaultQuestions);
        }
      })
      .catch((loadError: unknown) => {
        if (active) setError(loadError instanceof Error ? loadError.message : 'Could not load feedback questions.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  function toggle(choice: typeof choices[number], enabled: boolean) {
    if (choice.key === 'rating' && !enabled) return;
    setQuestions((current) => {
      const next = current.filter((question) => question.key !== choice.key);
      if (enabled) next.push({
        key: choice.key,
        type: choice.type,
        required: choice.key === 'rating',
      });
      return choices.flatMap((item) => next.filter((question) => question.key === item.key));
    });
  }

  async function save() {
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const currentResponse = await fetch('/api/engagement', { cache: 'no-store' });
      const currentResult = await currentResponse.json();
      if (!currentResponse.ok) throw new Error(currentResult.error || 'Could not load feedback settings.');
      const currentSettings = currentResult.feedbackSettings;
      const latestSettings = {
        enabled: Boolean(currentSettings?.enabled),
        delayMinutes: Number(currentSettings?.delay_minutes ?? 30),
        channel: ['WHATSAPP', 'EMAIL'].includes(currentSettings?.channel) ? currentSettings.channel : 'IN_APP',
      };
      const response = await fetch('/api/engagement', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'feedback',
          ...latestSettings,
          questions,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not save feedback questions.');
      setNotice('Feedback questions saved.');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save feedback questions.');
    } finally {
      setSaving(false);
    }
  }

  return <section className="surface-card engagement-form">
    <h2>Survey questions</h2>
    <p>All customers receive the same optional questions. Every rating uses a neutral 1–5 scale; the overall experience question is always required.</p>
    {choices.map((choice) => <label className="engagement-check" key={choice.key}>
      <input
        type="checkbox"
        checked={questions.some((question) => question.key === choice.key)}
        disabled={loading || saving || choice.key === 'rating'}
        onChange={(event) => toggle(choice, event.target.checked)}
      />
      {choice.label}
    </label>)}
    {error ? <div className="notice notice-error" role="alert">{error}</div> : null}
    {notice ? <div className="notice notice-success" role="status">{notice}</div> : null}
    <button className="button button-primary" disabled={loading || saving} onClick={() => void save()}>
      {saving ? 'Saving…' : 'Save survey questions'}
    </button>
  </section>;
}
