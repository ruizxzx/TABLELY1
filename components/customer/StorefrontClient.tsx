'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Search,
  Plus,
  Minus,
  ShoppingBag,
  Clock,
  MapPin,
  Bike,
  Store,
  ChevronRight,
  Leaf,
  Flame,
  CheckCircle2,
  AlertCircle,
  X,
  Phone,
} from 'lucide-react';
import {
  getPublicStorefrontContext,
  getPublicMenuForBranch,
  readFulfillmentCart,
  saveFulfillmentCart,
  clearFulfillmentCart,
  formatMoney,
  type PublicStorefrontContext,
  type PublicMenuItem,
  type CartItem,
} from '@/lib/customer';

export default function StorefrontClient({
  restaurantSlug,
  initialBranchId,
}: {
  restaurantSlug: string;
  initialBranchId?: string;
}) {
  const [context, setContext] = useState<PublicStorefrontContext | null>(null);
  const [menu, setMenu] = useState<PublicMenuItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedBranchId, setSelectedBranchId] = useState<string>(initialBranchId || '');
  const [fulfillmentType, setFulfillmentType] = useState<'PICKUP' | 'DELIVERY'>('PICKUP');
  const [pinCode, setPinCode] = useState('');
  const [pinStatus, setPinStatus] = useState<{ serviceable: boolean; message: string; fee?: number } | null>(null);

  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState<string>('ALL');
  const [cart, setCart] = useState<CartItem[]>([]);

  // Item customization modal
  const [customizingItem, setCustomizingItem] = useState<PublicMenuItem | null>(null);
  const [selectedVariant, setSelectedVariant] = useState<{ id: string; name: string; priceDelta: number } | null>(null);
  const [selectedAddons, setSelectedAddons] = useState<Array<{ name: string; price: number }>>([]);

  // Load Storefront Context
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    getPublicStorefrontContext(restaurantSlug, selectedBranchId || undefined)
      .then((ctx) => {
        if (cancelled) return;
        setContext(ctx);
        setSelectedBranchId(ctx.branch_id);

        // Default fulfillment type
        if (!ctx.pickup_enabled && ctx.delivery_enabled) {
          setFulfillmentType('DELIVERY');
        } else {
          setFulfillmentType('PICKUP');
        }

        // Sync local cart
        setCart(readFulfillmentCart(ctx.branch_id));

        // Load menu for selected branch
        return getPublicMenuForBranch(ctx.branch_id);
      })
      .then((menuItems) => {
        if (!cancelled && menuItems) {
          setMenu(menuItems);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load storefront.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [restaurantSlug, selectedBranchId]);

  // Sync cart changes across tabs
  useEffect(() => {
    if (!context?.branch_id) return;
    const branchId = context.branch_id;
    const sync = () => setCart(readFulfillmentCart(branchId));
    window.addEventListener('tablely-fulfillment-cart-change', sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener('tablely-fulfillment-cart-change', sync);
      window.removeEventListener('storage', sync);
    };
  }, [context?.branch_id]);

  // Validate Delivery PIN Code against branch zones
  function handlePinCheck(pin: string) {
    const cleanPin = pin.trim();
    setPinCode(cleanPin);
    if (!context || !cleanPin) {
      setPinStatus(null);
      return;
    }
    if (cleanPin.length !== 6) {
      setPinStatus({ serviceable: false, message: 'Enter a valid 6-digit PIN code.' });
      return;
    }

    const matchingZone = context.delivery_zones.find((z) => z.pin_codes.includes(cleanPin));
    if (matchingZone) {
      setPinStatus({
        serviceable: true,
        message: `Delivery available to ${matchingZone.name} in ~${matchingZone.estimated_min_minutes}–${matchingZone.estimated_max_minutes} mins. Delivery fee: ₹${matchingZone.delivery_fee}.`,
        fee: matchingZone.delivery_fee,
      });
    } else {
      setPinStatus({
        serviceable: false,
        message: `PIN ${cleanPin} is outside our current delivery radius. Pickup is still available!`,
      });
    }
  }

  // Categories extraction
  const categories = useMemo(() => {
    const map = new Map<string, { id: string; name: string; count: number }>();
    for (const item of menu) {
      if (!map.has(item.category_id)) {
        map.set(item.category_id, { id: item.category_id, name: item.category_name, count: 0 });
      }
      map.get(item.category_id)!.count++;
    }
    return Array.from(map.values());
  }, [menu]);

  // Filtered Items
  const filteredItems = useMemo(() => {
    return menu.filter((item) => {
      const matchesSearch =
        !search.trim() ||
        item.item_name?.toLowerCase().includes(search.toLowerCase().trim()) ||
        item.item_description?.toLowerCase().includes(search.toLowerCase().trim());
      const matchesCategory = activeCategory === 'ALL' || item.category_id === activeCategory;
      return matchesSearch && matchesCategory;
    });
  }, [menu, search, activeCategory]);

  // Cart Management
  function updateCart(items: CartItem[]) {
    if (!context?.branch_id) return;
    setCart(items);
    saveFulfillmentCart(context.branch_id, items);
  }

  function handleAddItem(item: PublicMenuItem) {
    if (!item.item_id || !item.item_name || item.item_price === null) return;

    // If item has variants or addons, open customizer modal
    const hasVariants = Array.isArray(item.variants) && item.variants.length > 0;
    const hasAddons = Array.isArray(item.addons) && item.addons.length > 0;
    if (hasVariants || hasAddons) {
      setCustomizingItem(item);
      setSelectedVariant(hasVariants ? { id: item.variants![0].id, name: item.variants![0].name, priceDelta: item.variants![0].price_delta } : null);
      setSelectedAddons([]);
      return;
    }

    const next = [...cart];
    const existingIndex = next.findIndex(
      (c) => c.menuItemId === item.item_id && !c.variant && (!c.addons || c.addons.length === 0),
    );

    if (existingIndex >= 0) {
      next[existingIndex].quantity += 1;
    } else {
      next.push({
        menuItemId: item.item_id,
        name: item.item_name,
        price: Number(item.item_price),
        quantity: 1,
        imageUrl: item.image_url,
      });
    }
    updateCart(next);
  }

  function handleAddCustomizedItem() {
    if (!customizingItem?.item_id || !customizingItem.item_name) return;

    const basePrice = Number(customizingItem.item_price ?? 0);
    const variantPrice = selectedVariant ? Number(selectedVariant.priceDelta) : 0;
    const addonsPrice = selectedAddons.reduce((sum, a) => sum + Number(a.price), 0);
    const finalUnitPrice = basePrice + variantPrice + addonsPrice;

    const next = [...cart];
    next.push({
      menuItemId: customizingItem.item_id,
      name: customizingItem.item_name,
      price: finalUnitPrice,
      quantity: 1,
      imageUrl: customizingItem.image_url,
      variant: selectedVariant ?? undefined,
      addons: selectedAddons,
    });

    updateCart(next);
    setCustomizingItem(null);
  }

  function handleDecrementItem(item: PublicMenuItem) {
    const next = [...cart];
    const index = next.findIndex((c) => c.menuItemId === item.item_id);
    if (index >= 0) {
      if (next[index].quantity > 1) {
        next[index].quantity -= 1;
      } else {
        next.splice(index, 1);
      }
      updateCart(next);
    }
  }

  const cartTotal = useMemo(() => {
    return cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
  }, [cart]);

  const cartCount = useMemo(() => {
    return cart.reduce((sum, item) => sum + item.quantity, 0);
  }, [cart]);

  if (loading) {
    return (
      <div className="storefront-loading">
        <div className="storefront-spinner" />
        <p>Loading restaurant menu…</p>
      </div>
    );
  }

  if (error || !context) {
    return (
      <div className="storefront-error">
        <AlertCircle size={32} />
        <h2>Online Ordering Unavailable</h2>
        <p>{error || 'Could not load storefront.'}</p>
      </div>
    );
  }

  return (
    <div className="storefront-container">
      {/* Cover and Restaurant Header */}
      <header className="storefront-header">
        {context.cover_url ? (
          <div className="storefront-cover" style={{ backgroundImage: `url(${context.cover_url})` }} />
        ) : (
          <div className="storefront-cover storefront-cover-placeholder" />
        )}

        <div className="storefront-profile">
          <div className="storefront-avatar">
            {context.logo_url ? (
              <img src={context.logo_url} alt={context.restaurant_name} />
            ) : (
              <Store size={36} />
            )}
          </div>
          <div className="storefront-info">
            <h1>{context.restaurant_name}</h1>
            <p className="storefront-address">
              <MapPin size={14} /> {context.branch_name} · {context.branch_address || 'Main Branch'}
            </p>
            {context.branch_phone && (
              <p className="storefront-phone">
                <Phone size={13} /> {context.branch_phone}
              </p>
            )}
          </div>
        </div>
      </header>

      {/* Multi-Branch Selector if available */}
      {context.branches && context.branches.length > 1 && (
        <div className="storefront-branch-bar">
          <label htmlFor="branch-select">Select Branch:</label>
          <select
            id="branch-select"
            value={selectedBranchId}
            onChange={(e) => setSelectedBranchId(e.target.value)}
          >
            {context.branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name} {b.address ? `(${b.address})` : ''}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Fulfillment Selection (Pickup vs Delivery) */}
      <section className="storefront-fulfillment-card">
        <div className="storefront-fulfillment-toggle">
          {context.pickup_enabled && (
            <button
              type="button"
              className={`fulfillment-btn ${fulfillmentType === 'PICKUP' ? 'active' : ''}`}
              onClick={() => setFulfillmentType('PICKUP')}
            >
              <Store size={18} />
              <div>
                <strong>Pickup</strong>
                <small>Ready in ~{context.default_prep_minutes} mins · Free</small>
              </div>
            </button>
          )}

          {context.delivery_enabled && (
            <button
              type="button"
              className={`fulfillment-btn ${fulfillmentType === 'DELIVERY' ? 'active' : ''}`}
              onClick={() => setFulfillmentType('DELIVERY')}
            >
              <Bike size={18} />
              <div>
                <strong>Delivery</strong>
                <small>Direct to your doorstep</small>
              </div>
            </button>
          )}
        </div>

        {/* PIN Code Validator for Delivery */}
        {fulfillmentType === 'DELIVERY' && (
          <div className="storefront-pin-checker">
            <label htmlFor="pincode-input">Check Delivery Availability:</label>
            <div className="pin-input-row">
              <input
                id="pincode-input"
                type="text"
                maxLength={6}
                placeholder="Enter 6-digit PIN code"
                value={pinCode}
                onChange={(e) => handlePinCheck(e.target.value)}
              />
            </div>
            {pinStatus && (
              <div className={`pin-status-alert ${pinStatus.serviceable ? 'success' : 'warning'}`}>
                {pinStatus.serviceable ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
                <span>{pinStatus.message}</span>
              </div>
            )}
          </div>
        )}

        {context.minimum_order_amount > 0 && (
          <div className="storefront-min-order">
            Min order value: {formatMoney(context.minimum_order_amount)}
          </div>
        )}
      </section>

      {/* Search and Category Navigation */}
      <div className="storefront-nav-sticky">
        <div className="storefront-search">
          <Search size={16} />
          <input
            type="search"
            placeholder="Search delicious dishes…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="storefront-categories">
          <button
            type="button"
            className={`category-pill ${activeCategory === 'ALL' ? 'active' : ''}`}
            onClick={() => setActiveCategory('ALL')}
          >
            All Items ({menu.length})
          </button>
          {categories.map((cat) => (
            <button
              type="button"
              key={cat.id}
              className={`category-pill ${activeCategory === cat.id ? 'active' : ''}`}
              onClick={() => setActiveCategory(cat.id)}
            >
              {cat.name} ({cat.count})
            </button>
          ))}
        </div>
      </div>

      {/* Menu Item Grid */}
      <main className="storefront-menu-grid">
        {filteredItems.map((item) => {
          const inCartCount = cart
            .filter((c) => c.menuItemId === item.item_id)
            .reduce((sum, c) => sum + c.quantity, 0);

          return (
            <article className="storefront-card" key={item.item_id}>
              <div className="card-content">
                <div className="card-header">
                  {item.is_veg ? (
                    <span className="badge-veg" title="Vegetarian">
                      <Leaf size={12} /> Veg
                    </span>
                  ) : (
                    <span className="badge-nonveg" title="Non-vegetarian">
                      Non-Veg
                    </span>
                  )}
                  {item.is_popular && (
                    <span className="badge-popular">
                      <Flame size={12} /> Popular
                    </span>
                  )}
                </div>
                <h3>{item.item_name}</h3>
                {item.item_description && <p>{item.item_description}</p>}
                <div className="card-footer">
                  <span className="card-price">{formatMoney(Number(item.item_price ?? 0))}</span>

                  {inCartCount > 0 ? (
                    <div className="cart-stepper">
                      <button
                        type="button"
                        aria-label="Decrease quantity"
                        onClick={() => handleDecrementItem(item)}
                      >
                        <Minus size={14} />
                      </button>
                      <span>{inCartCount}</span>
                      <button
                        type="button"
                        aria-label="Increase quantity"
                        onClick={() => handleAddItem(item)}
                      >
                        <Plus size={14} />
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="add-to-cart-btn"
                      onClick={() => handleAddItem(item)}
                    >
                      <Plus size={14} /> Add
                    </button>
                  )}
                </div>
              </div>

              {item.image_url && (
                <div className="card-media">
                  <img src={item.image_url} alt={item.item_name ?? 'Dish'} />
                </div>
              )}
            </article>
          );
        })}

        {filteredItems.length === 0 && (
          <div className="storefront-empty">
            <p>No dishes found matching your selection.</p>
          </div>
        )}
      </main>

      {/* Customization Modal */}
      {customizingItem && (
        <div className="modal-backdrop" onClick={() => setCustomizingItem(null)}>
          <div className="modal-card customization-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <div>
                <h2>{customizingItem.item_name}</h2>
                <span>Base price: {formatMoney(Number(customizingItem.item_price ?? 0))}</span>
              </div>
              <button
                type="button"
                className="icon-button"
                onClick={() => setCustomizingItem(null)}
              >
                <X size={18} />
              </button>
            </div>

            <div className="customization-body">
              {/* Variants */}
              {Array.isArray(customizingItem.variants) && customizingItem.variants.length > 0 && (
                <div className="customization-group">
                  <h4>Choose Portion / Size</h4>
                  {customizingItem.variants.map((v) => (
                    <label key={v.id} className="radio-label">
                      <input
                        type="radio"
                        name="variant"
                        checked={selectedVariant?.id === v.id}
                        onChange={() => setSelectedVariant({ id: v.id, name: v.name, priceDelta: v.price_delta })}
                      />
                      <span>{v.name}</span>
                      {Number(v.price_delta) !== 0 && (
                        <strong>
                          {v.price_delta > 0 ? `+${formatMoney(v.price_delta)}` : formatMoney(v.price_delta)}
                        </strong>
                      )}
                    </label>
                  ))}
                </div>
              )}

              {/* Addons */}
              {Array.isArray(customizingItem.addons) && customizingItem.addons.length > 0 && (
                <div className="customization-group">
                  <h4>Add-ons & Extras</h4>
                  {customizingItem.addons.map((a) => {
                    const isChecked = selectedAddons.some((x) => x.name === a.name);
                    return (
                      <label key={a.name} className="checkbox-label">
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedAddons([...selectedAddons, a]);
                            } else {
                              setSelectedAddons(selectedAddons.filter((x) => x.name !== a.name));
                            }
                          }}
                        />
                        <span>{a.name}</span>
                        <strong>+{formatMoney(Number(a.price))}</strong>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="modal-actions">
              <button
                type="button"
                className="button button-light"
                onClick={() => setCustomizingItem(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="button button-primary"
                onClick={handleAddCustomizedItem}
              >
                Add to Cart
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Floating Checkout Bar */}
      {cartCount > 0 && (
        <div className="storefront-floating-cart">
          <div className="cart-summary">
            <ShoppingBag size={20} />
            <div>
              <strong>
                {cartCount} item{cartCount === 1 ? '' : 's'} · {formatMoney(cartTotal)}
              </strong>
              <small>
                {fulfillmentType === 'PICKUP' ? 'For Store Pickup' : 'For Home Delivery'}
              </small>
            </div>
          </div>

          <Link
            href={`/r/${encodeURIComponent(restaurantSlug)}/order/checkout?branchId=${encodeURIComponent(selectedBranchId)}&type=${encodeURIComponent(fulfillmentType)}${pinCode ? `&pin=${encodeURIComponent(pinCode)}` : ''}`}
            className="checkout-link-btn"
          >
            Review & Checkout <ChevronRight size={18} />
          </Link>
        </div>
      )}
    </div>
  );
}
