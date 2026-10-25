'use client';

import { useEffect, useState } from 'react';
import {
  Save,
  Plus,
  Trash2,
  Edit2,
  RefreshCw,
  Store,
  Bike,
  MapPin,
  Clock,
  DollarSign,
  AlertCircle,
  CheckCircle2,
  X,
} from 'lucide-react';
import { StudioShell } from '@/components/StudioShell';
import { SectionHeader } from '@/components/SectionHeader';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import { getCurrentRestaurantContext } from '@/lib/restaurant-context';

type DeliveryZone = {
  id?: string;
  branch_id: string;
  name: string;
  supported_pin_codes: string[];
  delivery_fee: number;
  minimum_order_amount: number;
  free_delivery_threshold: number | null;
  estimated_min_minutes: number;
  estimated_max_minutes: number;
  is_active: boolean;
};

export default function OnlineOrderingSettingsPage() {
  const supabase = getSupabaseBrowserClient();
  const [branchId, setBranchId] = useState('');
  const [branchName, setBranchName] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Settings state
  const [settings, setSettings] = useState({
    online_ordering_enabled: false,
    pickup_enabled: false,
    delivery_enabled: false,
    default_prep_minutes: 25,
    minimum_order_amount: 0,
    pickup_packaging_fee: 0,
    delivery_packaging_fee: 0,
    pickup_instructions: 'Please show your pickup code at the counter.',
    delivery_instructions: 'Contact-free delivery available on request.',
    cod_enabled: false,
    upi_on_delivery_enabled: false,
    free_delivery_threshold: null as number | null,
  });

  // Zones state
  const [zones, setZones] = useState<DeliveryZone[]>([]);
  const [zoneModalOpen, setZoneModalOpen] = useState(false);
  const [editingZone, setEditingZone] = useState<DeliveryZone | null>(null);
  const [zoneFormPinString, setZoneFormPinString] = useState('');

  async function loadData() {
    if (!supabase) return;
    setLoading(true);
    setError(null);
    try {
      const context = await getCurrentRestaurantContext(supabase);
      if (!context.data) throw new Error('Restaurant context not found.');
      const bId = context.data.branch.id;
      setBranchId(bId);
      setBranchName(context.data.branch.name);

      // Read only. The settings initializer is intentionally internal to
      // SECURITY DEFINER RPCs; a missing row must stay safely disabled.
      const { data: s, error: sErr } = await supabase
        .from('branch_ordering_settings')
        .select('*')
        .eq('branch_id', bId)
        .maybeSingle();
      if (sErr) throw sErr;
      if (s) {
        const pickupMeta = s.pickup_settings || {};
        const deliveryMeta = s.delivery_settings || {};

        setSettings({
          online_ordering_enabled: s.online_ordering_enabled ?? false,
          pickup_enabled: s.pickup_enabled ?? false,
          delivery_enabled: s.delivery_enabled ?? false,
          default_prep_minutes: Number(s.default_prep_minutes ?? 25),
          minimum_order_amount: Number(s.minimum_order_amount ?? 0),
          pickup_packaging_fee: Number(s.pickup_packaging_fee ?? 0),
          delivery_packaging_fee: Number(s.delivery_packaging_fee ?? 0),
          pickup_instructions: pickupMeta.instructions ?? 'Please show your pickup code at the counter.',
          delivery_instructions: deliveryMeta.instructions ?? 'Contact-free delivery available on request.',
          cod_enabled: deliveryMeta.cod_enabled ?? false,
          upi_on_delivery_enabled: deliveryMeta.upi_on_delivery_enabled ?? false,
          free_delivery_threshold: deliveryMeta.free_delivery_threshold ?? null,
        });
      }

      // Fetch zones
      const { data: zData, error: zErr } = await supabase
        .from('delivery_zones')
        .select('*')
        .eq('branch_id', bId)
        .order('priority', { ascending: false })
        .order('created_at', { ascending: true });
      if (zErr) throw zErr;
      setZones(
        (zData ?? []).map((z) => ({
          id: z.id,
          branch_id: z.branch_id,
          name: z.name,
          supported_pin_codes: z.supported_pin_codes ?? [],
          delivery_fee: Number(z.delivery_fee),
          minimum_order_amount: Number(z.minimum_order_amount ?? 0),
          free_delivery_threshold: z.free_delivery_threshold ? Number(z.free_delivery_threshold) : null,
          estimated_min_minutes: Number(z.estimated_min_minutes ?? 30),
          estimated_max_minutes: Number(z.estimated_max_minutes ?? 45),
          is_active: z.is_active ?? true,
        })),
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not load online ordering settings.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadData();
  }, []);

  async function handleSaveSettings(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase || !branchId) return;
    setSaving(true);
    setError(null);
    setSuccess(null);

    try {
      const numericFields = [
        Number(settings.default_prep_minutes),
        Number(settings.minimum_order_amount),
        Number(settings.pickup_packaging_fee),
        Number(settings.delivery_packaging_fee),
      ];
      if (numericFields.some((value) => !Number.isFinite(value)) || numericFields[0] < 5 || numericFields[0] > 180 || numericFields.slice(1).some((value) => value < 0)) {
        throw new Error('Enter valid preparation time and non-negative order/fee amounts.');
      }
      if (settings.pickup_instructions.length > 1000 || settings.delivery_instructions.length > 1000) {
        throw new Error('Instructions must be 1000 characters or fewer.');
      }

      const { error: rpcErr } = await supabase.rpc('save_branch_ordering_settings', {
        p_branch_id: branchId,
        p_online_ordering_enabled: settings.online_ordering_enabled,
        p_pickup_enabled: settings.pickup_enabled,
        p_delivery_enabled: settings.delivery_enabled,
        p_default_prep_minutes: Number(settings.default_prep_minutes),
        p_minimum_order_amount: Number(settings.minimum_order_amount),
        p_pickup_packaging_fee: Number(settings.pickup_packaging_fee),
        p_delivery_packaging_fee: Number(settings.delivery_packaging_fee),
        p_pickup_instructions: settings.pickup_instructions,
        p_delivery_instructions: settings.delivery_instructions,
        p_cod_enabled: settings.cod_enabled,
        p_upi_on_delivery_enabled: settings.upi_on_delivery_enabled,
        p_free_delivery_threshold: settings.free_delivery_threshold,
        p_clear_free_delivery_threshold: settings.free_delivery_threshold === null,
      });
      if (rpcErr) throw rpcErr;


      setSuccess('Online ordering settings successfully saved.');
    } catch (err: unknown) {
      const msg =
        (err as { message?: string })?.message ??
        (err instanceof Error ? err.message : 'Could not save settings.');
      setError(msg);
    } finally {
      setSaving(false);
    }
  }

  function openCreateZoneModal() {
    setEditingZone({
      branch_id: branchId,
      name: '',
      supported_pin_codes: [],
      delivery_fee: 30,
      minimum_order_amount: 99,
      free_delivery_threshold: null,
      estimated_min_minutes: 30,
      estimated_max_minutes: 45,
      is_active: true,
    });
    setZoneFormPinString('');
    setZoneModalOpen(true);
  }

  function openEditZoneModal(zone: DeliveryZone) {
    setEditingZone(zone);
    setZoneFormPinString(zone.supported_pin_codes.join(', '));
    setZoneModalOpen(true);
  }

  async function handleSaveZone(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase || !editingZone || !branchId) return;

    const rawPins = zoneFormPinString.split(',').map((p) => p.trim()).filter(Boolean);
    if (rawPins.some((pin) => !/^\d{6}$/.test(pin))) {
      alert('Every PIN code must contain exactly 6 digits.');
      return;
    }
    const pins = Array.from(new Set(rawPins));
    const feeValues = [editingZone.delivery_fee, editingZone.minimum_order_amount, editingZone.estimated_min_minutes, editingZone.estimated_max_minutes];
    if (!editingZone.name.trim() || pins.length === 0 || feeValues.some((value) => !Number.isFinite(Number(value)) || Number(value) < 0) || editingZone.estimated_min_minutes < 1 || editingZone.estimated_max_minutes < editingZone.estimated_min_minutes) {
      alert('Check the zone name, PIN codes, fees and delivery time range.');
      return;
    }
    if (editingZone.free_delivery_threshold !== null && (!Number.isFinite(Number(editingZone.free_delivery_threshold)) || Number(editingZone.free_delivery_threshold) < 0)) {
      alert('Free-delivery threshold must be a non-negative amount.');
      return;
    }

    try {
      if (editingZone.id) {
        // Update
        const { error: zErr } = await supabase
          .from('delivery_zones')
          .update({
            name: editingZone.name.trim(),
            supported_pin_codes: pins,
            delivery_fee: editingZone.delivery_fee,
            minimum_order_amount: editingZone.minimum_order_amount,
            free_delivery_threshold: editingZone.free_delivery_threshold,
            estimated_min_minutes: editingZone.estimated_min_minutes,
            estimated_max_minutes: editingZone.estimated_max_minutes,
            is_active: editingZone.is_active,
            updated_at: new Date().toISOString(),
          })
          .eq('id', editingZone.id);
        if (zErr) throw zErr;
      } else {
        // Insert
        const { error: zErr } = await supabase.from('delivery_zones').insert({
          branch_id: branchId,
          name: editingZone.name.trim(),
          supported_pin_codes: pins,
          delivery_fee: editingZone.delivery_fee,
          minimum_order_amount: editingZone.minimum_order_amount,
          free_delivery_threshold: editingZone.free_delivery_threshold,
          estimated_min_minutes: editingZone.estimated_min_minutes,
          estimated_max_minutes: editingZone.estimated_max_minutes,
          is_active: editingZone.is_active,
        });
        if (zErr) throw zErr;
      }

      setZoneModalOpen(false);
      void loadData();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Could not save delivery zone.');
    }
  }

  async function handleDeleteZone(zoneId: string, name: string) {
    if (!supabase) return;
    if (!confirm(`Delete delivery zone "${name}"?`)) return;

    try {
      const { error: dErr } = await supabase.from('delivery_zones').delete().eq('id', zoneId);
      if (dErr) throw dErr;
      void loadData();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Could not delete delivery zone.');
    }
  }

  if (loading) {
    return (
      <StudioShell>
        <div className="setup-loading">Loading online ordering settings…</div>
      </StudioShell>
    );
  }

  return (
    <StudioShell>
      <SectionHeader
        eyebrow="SETTINGS"
        title="Online Ordering & Delivery"
        description={`Configure customer storefront, self pickup, home delivery, and delivery zones for ${branchName}.`}
        action={
          <div className="button-row">
            <button
              type="button"
              className="button button-light"
              onClick={() => void loadData()}
              disabled={loading}
            >
              <RefreshCw size={15} /> Refresh
            </button>
            <button
              type="button"
              className="button button-primary"
              onClick={handleSaveSettings}
              disabled={saving}
            >
              <Save size={15} /> {saving ? 'Saving…' : 'Save Settings'}
            </button>
          </div>
        }
      />

      {error && <div className="notice notice-error" role="alert">{error}</div>}
      {success && <div className="notice notice-info">{success}</div>}
      <div className="notice notice-info" role="status">
        Online ordering, pickup, delivery and payment-on-delivery options remain off until an authorized manager enables them and saves the settings. Automatic acceptance is disabled in this foundation build.
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 20 }}>
        {/* General Ordering Controls */}
        <div className="surface-card" style={{ padding: 20 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 16px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Store size={18} /> General Storefront Settings
          </h2>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontWeight: 600 }}>
              <input
                type="checkbox"
                checked={settings.online_ordering_enabled}
                onChange={(e) => setSettings({ ...settings, online_ordering_enabled: e.target.checked })}
              />
              <span>Enable Online Ordering Storefront</span>
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
              Default Kitchen Preparation Time (minutes)
              <input
                type="number"
                min="5"
                max="180"
                value={settings.default_prep_minutes}
                onChange={(e) => setSettings({ ...settings, default_prep_minutes: Number(e.target.value) })}
                style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #cbd5e1' }}
              />
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
              Global Minimum Order Value (₹)
              <input
                type="number"
                min="0"
                step="1"
                value={settings.minimum_order_amount}
                onChange={(e) => setSettings({ ...settings, minimum_order_amount: Number(e.target.value) })}
                style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #cbd5e1' }}
              />
            </label>
          </div>
        </div>

        {/* Pickup Settings */}
        <div className="surface-card" style={{ padding: 20 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 16px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Store size={18} /> Self Pickup Settings
          </h2>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontWeight: 600 }}>
              <input
                type="checkbox"
                checked={settings.pickup_enabled}
                onChange={(e) => setSettings({ ...settings, pickup_enabled: e.target.checked })}
              />
              <span>Enable Customer Self Pickup</span>
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
              Pickup Packaging Fee (₹)
              <input
                type="number"
                min="0"
                step="1"
                value={settings.pickup_packaging_fee}
                onChange={(e) => setSettings({ ...settings, pickup_packaging_fee: Number(e.target.value) })}
                style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #cbd5e1' }}
              />
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
              Collection Instructions for Customer
              <textarea
                rows={2}
                value={settings.pickup_instructions}
                onChange={(e) => setSettings({ ...settings, pickup_instructions: e.target.value })}
                style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #cbd5e1' }}
              />
            </label>
          </div>
        </div>

        {/* Delivery Settings */}
        <div className="surface-card" style={{ padding: 20, gridColumn: '1 / -1' }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 16px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Bike size={18} /> Restaurant Delivery Settings
          </h2>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontWeight: 600 }}>
              <input
                type="checkbox"
                checked={settings.delivery_enabled}
                onChange={(e) => setSettings({ ...settings, delivery_enabled: e.target.checked })}
              />
              <span>Enable Home Delivery</span>
            </label>

            <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={settings.cod_enabled}
                onChange={(e) => setSettings({ ...settings, cod_enabled: e.target.checked })}
              />
              <span>Cash on Delivery (COD)</span>
            </label>

            <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={settings.upi_on_delivery_enabled}
                onChange={(e) => setSettings({ ...settings, upi_on_delivery_enabled: e.target.checked })}
              />
              <span>UPI on Delivery</span>
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
              Delivery Packaging Fee (₹)
              <input
                type="number"
                min="0"
                step="1"
                value={settings.delivery_packaging_fee}
                onChange={(e) => setSettings({ ...settings, delivery_packaging_fee: Number(e.target.value) })}
                style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #cbd5e1' }}
              />
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
              Default Delivery Instructions
              <input
                type="text"
                value={settings.delivery_instructions}
                onChange={(e) => setSettings({ ...settings, delivery_instructions: e.target.value })}
                style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #cbd5e1' }}
              />
            </label>
          </div>
        </div>
      </div>

      {/* Delivery Zones Manager */}
      <section className="surface-card" style={{ marginTop: 24, padding: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div>
            <h2 style={{ fontSize: 17, fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
              <MapPin size={18} /> Delivery Coverage Zones
            </h2>
            <p style={{ fontSize: 13, color: '#64748b', margin: '4px 0 0' }}>
              Define serviceable PIN codes, zone-based delivery charges, and ETA estimates.
            </p>
          </div>
          <button type="button" className="button button-primary compact" onClick={openCreateZoneModal}>
            <Plus size={14} /> Add Delivery Zone
          </button>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table className="table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>Zone Name</th>
                <th>Supported PIN Codes</th>
                <th>Delivery Fee</th>
                <th>Min Order</th>
                <th>Free Delivery Over</th>
                <th>Estimated Time</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {zones.length === 0 ? (
                <tr>
                  <td colSpan={8} style={{ textAlign: 'center', padding: '30px', color: '#64748b' }}>
                    No delivery zones configured yet. Add your first zone to enable home delivery checkout.
                  </td>
                </tr>
              ) : (
                zones.map((zone) => (
                  <tr key={zone.id}>
                    <td><strong>{zone.name}</strong></td>
                    <td>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        {zone.supported_pin_codes.map((pin) => (
                          <span
                            key={pin}
                            style={{
                              background: '#f1f5f9',
                              padding: '2px 6px',
                              borderRadius: 4,
                              fontSize: 12,
                              fontFamily: 'monospace',
                            }}
                          >
                            {pin}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td>₹{zone.delivery_fee}</td>
                    <td>₹{zone.minimum_order_amount}</td>
                    <td>{zone.free_delivery_threshold ? `₹${zone.free_delivery_threshold}` : '—'}</td>
                    <td>{zone.estimated_min_minutes}–{zone.estimated_max_minutes} mins</td>
                    <td>
                      <span className={`status-pill ${zone.is_active ? 'active' : 'inactive'}`}>
                        {zone.is_active ? 'Active' : 'Disabled'}
                      </span>
                    </td>
                    <td>
                      <div className="button-row">
                        <button
                          type="button"
                          className="button button-light compact"
                          onClick={() => openEditZoneModal(zone)}
                        >
                          <Edit2 size={13} />
                        </button>
                        <button
                          type="button"
                          className="button button-light compact danger-button"
                          onClick={() => zone.id && handleDeleteZone(zone.id, zone.name)}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Zone Create / Edit Modal */}
      {zoneModalOpen && editingZone && (
        <div className="modal-backdrop" onClick={() => setZoneModalOpen(false)}>
          <div className="modal-card compact-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <div>
                <h2>{editingZone.id ? 'Edit Delivery Zone' : 'Create Delivery Zone'}</h2>
              </div>
              <button type="button" className="icon-button" onClick={() => setZoneModalOpen(false)}>
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleSaveZone} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
                Zone Name *
                <input
                  type="text"
                  required
                  placeholder="e.g. Nearby Barrackpore (Zone A)"
                  value={editingZone.name}
                  onChange={(e) => setEditingZone({ ...editingZone, name: e.target.value })}
                  style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #cbd5e1' }}
                />
              </label>

              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
                Supported PIN Codes (comma-separated 6-digit PINs) *
                <input
                  type="text"
                  required
                  placeholder="e.g. 700120, 700121, 700122"
                  value={zoneFormPinString}
                  onChange={(e) => setZoneFormPinString(e.target.value)}
                  style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #cbd5e1' }}
                />
              </label>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
                  Delivery Fee (₹) *
                  <input
                    type="number"
                    min="0"
                    step="1"
                    required
                    value={editingZone.delivery_fee}
                    onChange={(e) => setEditingZone({ ...editingZone, delivery_fee: Number(e.target.value) })}
                    style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #cbd5e1' }}
                  />
                </label>

                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
                  Minimum Order Value (₹)
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={editingZone.minimum_order_amount}
                    onChange={(e) => setEditingZone({ ...editingZone, minimum_order_amount: Number(e.target.value) })}
                    style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #cbd5e1' }}
                  />
                </label>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
                  Free Delivery Above (₹)
                  <input
                    type="number"
                    min="0"
                    step="1"
                    placeholder="Optional threshold"
                    value={editingZone.free_delivery_threshold ?? ''}
                    onChange={(e) =>
                      setEditingZone({
                        ...editingZone,
                        free_delivery_threshold: e.target.value ? Number(e.target.value) : null,
                      })
                    }
                    style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #cbd5e1' }}
                  />
                </label>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
                    Min Mins
                    <input
                      type="number"
                      min="5"
                      value={editingZone.estimated_min_minutes}
                      onChange={(e) => setEditingZone({ ...editingZone, estimated_min_minutes: Number(e.target.value) })}
                      style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #cbd5e1' }}
                    />
                  </label>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
                    Max Mins
                    <input
                      type="number"
                      min="10"
                      value={editingZone.estimated_max_minutes}
                      onChange={(e) => setEditingZone({ ...editingZone, estimated_max_minutes: Number(e.target.value) })}
                      style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #cbd5e1' }}
                    />
                  </label>
                </div>
              </div>

              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={editingZone.is_active}
                  onChange={(e) => setEditingZone({ ...editingZone, is_active: e.target.checked })}
                />
                <span>Zone Active for Customer Delivery</span>
              </label>

              <div className="modal-actions" style={{ marginTop: 12 }}>
                <button type="button" className="button button-light" onClick={() => setZoneModalOpen(false)}>
                  Cancel
                </button>
                <button type="submit" className="button button-primary">
                  Save Zone
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </StudioShell>
  );
}
