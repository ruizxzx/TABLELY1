'use client';

import { useState } from 'react';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

type Props = {
  value: string;
  onChange: (value: string) => void;
};

const LONG_TEXT_KEYS = new Set(['body', 'description', 'intro', 'story', 'closing', 'message', 'answer', 'seo_description']);

function labelForKey(key: string) {
  return key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/\b\w/g, character => character.toUpperCase());
}

function isObject(value: JsonValue): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isScalar(value: JsonValue): value is string | number | boolean | null {
  return value === null || typeof value !== 'object';
}

function emptyValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.length ? emptyValue(value[0]) : '';
  if (isObject(value)) return {};
  if (typeof value === 'number') return 0;
  if (typeof value === 'boolean') return false;
  return '';
}

function updateAtPath(value: JsonValue, path: (string | number)[], next: JsonValue): JsonValue {
  if (!path.length) return next;
  const [head, ...rest] = path;
  if (Array.isArray(value) && typeof head === 'number') return value.map((item, index) => index === head ? updateAtPath(item, rest, next) : item);
  if (isObject(value) && typeof head === 'string') return { ...value, [head]: updateAtPath(value[head], rest, next) };
  return value;
}

function removeAtPath(value: JsonValue, path: (string | number)[]): JsonValue {
  if (!path.length) return value;
  const [head, ...rest] = path;
  if (Array.isArray(value) && typeof head === 'number') {
    if (!rest.length) return value.filter((_, index) => index !== head);
    return value.map((item, index) => index === head ? removeAtPath(item, rest) : item);
  }
  if (isObject(value) && typeof head === 'string') {
    if (!rest.length) { const next = { ...value }; delete next[head]; return next; }
    return { ...value, [head]: removeAtPath(value[head], rest) };
  }
  return value;
}

function Field({ label, value, path, onChange, onRemove }: { label: string; value: JsonValue; path: (string | number)[]; onChange: (path: (string | number)[], value: JsonValue) => void; onRemove?: () => void }) {
  const [newFieldName, setNewFieldName] = useState('');

  if (isScalar(value)) {
    const stringValue = value === null ? '' : String(value);
    const longText = LONG_TEXT_KEYS.has(String(path[path.length - 1])) || stringValue.length > 120;

    return (
      <div className="simple-field">
        <div className="simple-field-head">
          <label>{label}</label>
          {onRemove && <button type="button" className="simple-link danger" onClick={onRemove}>Remove</button>}
        </div>
        {typeof value === 'boolean' ? (
          <label className="simple-checkbox">
            <input type="checkbox" checked={value} onChange={event => onChange(path, event.target.checked)} />
            <span>{value ? 'Enabled' : 'Disabled'}</span>
          </label>
        ) : longText ? (
          <textarea className="input simple-control" value={stringValue} onChange={event => onChange(path, event.target.value)} rows={4} />
        ) : (
          <input className="input simple-control" type={typeof value === 'number' ? 'number' : 'text'} value={stringValue} onChange={event => onChange(path, typeof value === 'number' ? Number(event.target.value) : event.target.value)} />
        )}
      </div>
    );
  }

  if (Array.isArray(value)) {
    if (!value.length) {
      return (
        <div className="simple-empty">
          <span>No items yet.</span>
          <button type="button" className="simple-link" onClick={() => onChange(path, [emptyValue('')])}>Add first item</button>
        </div>
      );
    }

    return (
      <div className="simple-array">
        {value.map((item, index) => (
          <div className="simple-array-item" key={`${path.join('.')}-${index}`}>
            <div className="simple-array-item-head">
              <strong>{label} {index + 1}</strong>
              <button type="button" className="simple-link danger" onClick={() => onChange(path, removeAtPath(value, [index]))}>Remove</button>
            </div>
            <Field label={label} value={item} path={[...path, index]} onChange={onChange} />
          </div>
        ))}
        <button type="button" className="simple-add-button" onClick={() => onChange(path, [...value, emptyValue(value[0] ?? '')])}>Add item</button>
      </div>
    );
  }

  const entries = Object.entries(value as JsonObject);
  return (
    <div className="simple-object">
      {entries.length === 0 ? (
        <div className="simple-empty">
          <span>No fields yet.</span>
        </div>
      ) : entries.map(([key, child]) => (
        <Field key={key} label={labelForKey(key)} value={child} path={[...path, key]} onChange={onChange} onRemove={() => onChange(path, removeAtPath(value, [key]))} />
      ))}
      <div className="simple-add-row">
        <input className="input simple-control" value={newFieldName} onChange={event => setNewFieldName(event.target.value)} placeholder="Add field name" />
        <button type="button" className="simple-add-button" onClick={() => {
          const key = newFieldName.trim();
          if (!key || key in value) return;
          onChange(path, { ...value, [key]: '' });
          setNewFieldName('');
        }}>Add field</button>
      </div>
    </div>
  );
}

export default function StructuredContentEditor({ value, onChange }: Props) {
  const [parseError, setParseError] = useState('');
  let parsed: JsonValue;

  try {
    parsed = JSON.parse(value) as JsonValue;
  } catch {
    parsed = {};
  }

  function update(path: (string | number)[], next: JsonValue) {
    try {
      const nextValue = updateAtPath(parsed, path, next);
      onChange(JSON.stringify(nextValue, null, 2));
      setParseError('');
    } catch {
      setParseError('Could not update this field.');
    }
  }

  if (!isObject(parsed)) {
    parsed = {} as JsonObject;
  }

  const entries = Object.entries(parsed as JsonObject);

  return (
    <div className="simple-editor">
      <div className="simple-editor-header">
        <div>
          <b>Content fields</b>
          <span>Write directly into each section without the nested JSON blocks.</span>
        </div>
        {parseError && <em>{parseError}</em>}
      </div>
      <div className="simple-editor-grid">
        {entries.length ? entries.map(([key, child]) => (
          <div className="simple-editor-card" key={key}>
            <div className="simple-editor-card-label">{labelForKey(key)}</div>
            <Field label={labelForKey(key)} value={child} path={[key]} onChange={update} />
          </div>
        )) : (
          <div className="simple-editor-empty">No content fields found for this page yet.</div>
        )}
      </div>
    </div>
  );
}
