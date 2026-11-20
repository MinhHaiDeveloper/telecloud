import React, { useMemo, useState } from 'react';
import { Dialog, Select } from './ui';
import Icon from './Icon';
import { FIELDS, FIELD, opsFor, newRule, smartTracks, SORTS } from '../utils/smartPlaylist';
import { t } from '../i18n';

const MATCH = [
  { value: 'all', get label() { return t('all of these rules'); } },
  { value: 'any', get label() { return t('any of these rules'); } },
];

/** One rule: what to look at, how to compare, and with what */
function RuleRow({ rule, onChange, onRemove, canRemove }) {
  const f = FIELD[rule.field] || FIELDS[0];
  const ops = opsFor(f.value);
  const set = (patch) => onChange({ ...rule, ...patch });
  const num = (v) => (v === '' ? '' : v);
  return (
    <div className="sp-rule">
      <Select value={f.value} options={FIELDS.map(x => ({ value: x.value, label: x.label }))} onChange={(v) => onChange(newRule(v))} width={150} />
      <Select value={rule.op} options={ops} onChange={(op) => set({ op })} width={160} />
      {f.kind === 'text' && (
        <input className="input sm" value={rule.value} placeholder={f.label} onChange={(e) => set({ value: e.target.value })} aria-label={t('{label} value', { label: f.label })} />
      )}
      {f.kind === 'number' && (
        <span className="sp-num">
          <input className="input sm mono" type="number" step="any" value={num(rule.value)} onChange={(e) => set({ value: e.target.value })} aria-label={t('{label} value', { label: f.label })} />
          {rule.op === 'between' && <><span className="muted">{t('and')}</span><input className="input sm mono" type="number" step="any" value={num(rule.value2)} onChange={(e) => set({ value2: e.target.value })} aria-label={t('{label} second value', { label: f.label })} /></>}
          {f.unit && <span className="muted">{f.unit}</span>}
        </span>
      )}
      {f.kind === 'date' && rule.op !== 'never' && (
        <span className="sp-num">
          <input className="input sm mono" type="number" min="1" value={num(rule.value)} onChange={(e) => set({ value: e.target.value })} aria-label={t('Days')} />
          <span className="muted">{t('days')}</span>
        </span>
      )}
      {f.kind === 'date' && rule.op === 'never' && <span />}
      {f.kind === 'choice' && <Select value={rule.value} options={f.choices} onChange={(value) => set({ value })} width={170} />}
      <button className="icon-btn sm" onClick={onRemove} disabled={!canRemove} title={t('Remove this rule')} aria-label={t('Remove this rule')}><Icon name="close" /></button>
    </div>
  );
}

/**
 * Make or change a smart playlist. `playlist` is the one being edited (null for a new one). The number of
 * matching tracks is shown as the rules change.
 */
const SmartPlaylistDialog = ({ playlist, files, ctx, onSave, onClose }) => {
  const start = playlist?.smart || { match: 'all', rules: [newRule('genre')], sort: 'artist', limit: 0 };
  const [name, setName] = useState(playlist?.name || '');
  const [smart, setSmart] = useState({ ...start, rules: start.rules.map(r => ({ ...r })) });
  const count = useMemo(() => smartTracks(smart, files, ctx).length, [smart, files, ctx]);
  const set = (patch) => setSmart(s => ({ ...s, ...patch }));
  const setRule = (i, r) => set({ rules: smart.rules.map((x, k) => (k === i ? r : x)) });
  const ok = name.trim() && smart.rules.length;
  const save = () => { if (ok) onSave({ name: name.trim(), smart: { ...smart, limit: Math.max(0, Math.round(Number(smart.limit) || 0)) } }); };
  return (
    <Dialog title={playlist ? t('Edit smart playlist') : t('New smart playlist')} icon="sparkle" onClose={onClose} width={720}
      actions={<>
        <span className="sp-count muted">{count.toLocaleString()} {count === 1 ? t('track matches') : t('tracks match')}</span>
        <button className="btn-ghost" onClick={onClose}>{t('Cancel')}</button>
        <button className="btn-primary" onClick={save} disabled={!ok}>{playlist ? t('Save') : t('Create')}</button>
      </>}>
      <div className="sp-dialog">
        <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t('Playlist name, like “Hi-Res I haven\'t played lately”')}
          onKeyDown={(e) => { if (e.key === 'Enter') save(); }} aria-label={t('Playlist name')} />
        <div className="sp-match"><span>{t('Tracks that match')}</span><Select value={smart.match} options={MATCH} onChange={(match) => set({ match })} width={190} /></div>
        <div className="sp-rules">
          {smart.rules.map((r, i) => (
            <RuleRow key={i} rule={r} onChange={(nr) => setRule(i, nr)} onRemove={() => set({ rules: smart.rules.filter((_, k) => k !== i) })} canRemove={smart.rules.length > 1} />
          ))}
          <button className="btn-ghost sm sp-add" onClick={() => set({ rules: [...smart.rules, newRule('artist')] })}><Icon name="plus" />{t('Add a rule')}</button>
        </div>
        <div className="sp-match">
          <span>{t('Order')}</span><Select value={smart.sort || 'artist'} options={SORTS} onChange={(sort) => set({ sort, seed: sort === 'random' ? Date.now() : smart.seed })} width={210} />
          <span>{t('Up to')}</span>
          <input className="input sm mono sp-limit" type="number" min="0" value={smart.limit || ''} placeholder={t('all')} onChange={(e) => set({ limit: e.target.value })} aria-label={t('Most tracks')} />
          <span className="muted">{t('tracks')}</span>
        </div>
        <p className="muted sp-hint">{t('It keeps itself up to date: new music, plays and favourites change it by themselves. It shows on the remote like any playlist.')}</p>
      </div>
    </Dialog>
  );
};

export default SmartPlaylistDialog;
