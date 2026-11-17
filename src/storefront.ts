import { signInWithPopup, signOut, onAuthStateChanged, type User } from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  writeBatch,
  type Unsubscribe,
} from 'firebase/firestore';
import {
  auth,
  db,
  googleProvider,
  handleFirestoreError,
  isVerifiedOwnerAdmin,
  OperationType,
  OWNER_ADMIN_EMAIL,
} from './firebase';
import {
  BLUEPRINT_LIMITS,
  buildNtfyPayload,
  calculateOrderTotal,
  filterProducts,
  formatCurrency,
  MAX_ORDER_QUANTITY,
  normalizeAssetUrl,
  resolveInitialProducts,
  validateOrderInput,
  validateProductInput,
  type ContactMethod,
  type PrintCategory,
  type PrintOrder,
  type PrintProduct,
  type SortOption,
} from './utils/printMenuLogic';

interface FilamentColor {
  id: string;
  name: string;
  hex: string;
}

interface StoreSettings {
  ntfyTopic: string;
  demoVideoUrl: string;
}

const FILAMENT_PALETTE: FilamentColor[] = [
  { id: 'galaxy-purple', name: 'Galaxy Purple', hex: '#7c3aed' },
  { id: 'silk-cyan', name: 'Silk Cyan', hex: '#06b6d4' },
  { id: 'matte-black', name: 'Matte Black', hex: '#1e293b' },
  { id: 'coral-red', name: 'Coral Red', hex: '#f43f5e' },
  { id: 'pearl-pink', name: 'Pearl Pink', hex: '#f472b6' },
  { id: 'cobalt-blue', name: 'Cobalt Blue', hex: '#3b82f6' },
  { id: 'emerald-silk', name: 'Emerald Silk', hex: '#10b981' },
  { id: 'arctic-white', name: 'Arctic White', hex: '#f8fafc' },
];

const DEFAULT_SETTINGS: StoreSettings = {
  ntfyTopic: 'ziauddin-3dprints-209',
  demoVideoUrl: '',
};

const DEFAULT_PRODUCTS: PrintProduct[] = [
  {
    id: 'infinity-cube',
    title: 'Articulated Infinity Cube',
    price: 4.0,
    category: 'Fidgets',
    description: 'Eight interlocking hinges printed in one piece for smooth, quiet folding.',
    imageUrl: './assets/images/print_infinity_cube_1794801362371.jpg',
    inStock: true,
    colors: ['Galaxy Purple', 'Matte Black', 'Silk Cyan', 'Cobalt Blue'],
    sortOrder: 0,
  },
  {
    id: 'crystal-flexi-dragon',
    title: 'Crystal Flexi Dragon',
    price: 8.5,
    category: 'Flexi Toys',
    description: 'Articulated 18-segment crystal dragon with fluid spine movement.',
    imageUrl: './assets/images/print_flexi_dragon_1794801362157.jpg',
    inStock: true,
    colors: ['Silk Cyan', 'Galaxy Purple', 'Emerald Silk', 'Coral Red'],
    sortOrder: 1,
  },
  {
    id: 'switch-clicker-keychain',
    title: 'Mechanical Switch Clicker',
    price: 3.0,
    category: 'Fidgets',
    description: 'Pocket-sized tactile mechanical keyboard switch keychain with metal ring.',
    imageUrl: './assets/images/print_clicker_keychain_1794801363241.jpg',
    inStock: true,
    colors: ['Coral Red', 'Matte Black', 'Cobalt Blue', 'Galaxy Purple'],
    sortOrder: 2,
  },
  {
    id: 'flexi-axolotl',
    title: 'Pocket Flexi Axolotl',
    price: 5.5,
    category: 'Flexi Toys',
    description: 'Articulated two-tone axolotl with flexible tail joints.',
    imageUrl: './assets/images/print_flexi_axolotl_1794801362968.jpg',
    inStock: true,
    colors: ['Pearl Pink', 'Arctic White', 'Silk Cyan', 'Galaxy Purple'],
    sortOrder: 3,
  },
  {
    id: 'modular-desk-tray',
    title: 'Modular Pen & Earbud Tray',
    price: 7.0,
    category: 'Desk Gear',
    description: 'Geometric pen cup paired with a recessed cable channel and earbud dock.',
    imageUrl: './assets/images/print_desk_organizer_1794801363925.jpg',
    inStock: true,
    colors: ['Matte Black', 'Cobalt Blue', 'Arctic White', 'Galaxy Purple'],
    sortOrder: 4,
  },
  {
    id: 'phone-controller-dock',
    title: 'Phone & Controller Stand',
    price: 6.5,
    category: 'Desk Gear',
    description: 'Angled faceted desk stand that holds a phone and controller side by side.',
    imageUrl: './assets/images/print_phone_stand_1794801377010.jpg',
    inStock: true,
    colors: ['Cobalt Blue', 'Matte Black', 'Coral Red', 'Silk Cyan'],
    sortOrder: 5,
  },
];

const CONTACT_HINTS: Record<ContactMethod, string> = {
  Phone: 'e.g. (555) 234-5678',
  Discord: 'e.g. @alex_09',
  Email: 'e.g. alex@example.com',
};

const state = {
  products: DEFAULT_PRODUCTS.map((p) => ({ ...p, colors: [...p.colors] })) as PrintProduct[],
  firestoreProducts: [] as PrintProduct[],
  firestoreProductsReady: false,
  catalogInitialized: false,
  settingsReady: false,
  orders: [] as PrintOrder[],
  settings: { ...DEFAULT_SETTINGS },
  currentUser: null as User | null,
  activeCategory: 'All',
  sortBy: 'default' as SortOption,
  searchQuery: '',
  selectedColorsByProduct: {} as Record<string, string>,
  activeProductId: null as string | null,
  detailZoomed: false,
  contactMethod: 'Phone' as ContactMethod,
  activeDockTarget: 'home',
  adminActiveTab: 'products',
  pendingDeleteProductId: null as string | null,
  confirmClearOrders: false,
};

let unsubProducts: Unsubscribe | null = null;
let unsubSettings: Unsubscribe | null = null;
let unsubOrders: Unsubscribe | null = null;
let pulseTimer: number | undefined;

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Missing DOM element #${id}`);
  }
  return el as T;
}

function getColorHex(name: string): string {
  const found = FILAMENT_PALETTE.find((c) => c.name.toLowerCase() === String(name).toLowerCase());
  return found ? found.hex : '#38bdf8';
}

function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function createSvgFallbackMarkup(title: string, colorHex: string): string {
  return `
    <div class="card-svg-fallback">
      <svg width="64" height="64" viewBox="0 0 64 64" fill="none" aria-hidden="true">
        <polygon points="32,8 54,20 54,44 32,56 10,44 10,20" stroke="${colorHex}" stroke-width="2.5" fill="rgba(255,255,255,0.06)"/>
        <polyline points="10,20 32,32 54,20" stroke="${colorHex}" stroke-width="2" stroke-opacity="0.85"/>
        <line x1="32" y1="32" x2="32" y2="56" stroke="${colorHex}" stroke-width="2" stroke-opacity="0.85"/>
      </svg>
      <span style="font-size:0.84rem;color:#f8fafc;font-weight:600;text-align:center;">${escapeHtml(title)}</span>
    </div>
  `;
}

function extractYouTubeEmbedUrl(url: string): string | null {
  const trimmed = String(url || '').trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname.includes('youtu.be')) {
      const id = parsed.pathname.replace('/', '').trim();
      return id ? `https://www.youtube.com/embed/${encodeURIComponent(id)}` : null;
    }
    if (parsed.hostname.includes('youtube.com')) {
      if (parsed.pathname.startsWith('/embed/')) return trimmed;
      const v = parsed.searchParams.get('v');
      return v ? `https://www.youtube.com/embed/${encodeURIComponent(v)}` : null;
    }
  } catch {
    return null;
  }
  return null;
}

async function sendNtfyNotification(
  url: string,
  headers: Record<string, string>,
  body: string
): Promise<boolean> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
    window.clearTimeout(timer);
    return res.ok;
  } catch {
    window.clearTimeout(timer);
    return false;
  }
}

/* Fluid Sliding Liquid-Glass Lens Positioner */
function moveSlidingLens(
  trackEl: HTMLElement | null,
  lensEl: (HTMLElement & { _flowTimer?: number }) | null,
  activeBtn: HTMLElement | null
): void {
  if (!trackEl || !lensEl || !activeBtn) return;
  const left = activeBtn.offsetLeft;
  const width = activeBtn.offsetWidth;
  if (width <= 0) return;

  lensEl.classList.add('is-flowing');
  lensEl.style.width = `${width}px`;
  lensEl.style.transform = `translate3d(${left}px, 0, 0)`;

  window.clearTimeout(lensEl._flowTimer);
  lensEl._flowTimer = window.setTimeout(() => {
    lensEl.classList.remove('is-flowing');
  }, 380);
}

function syncAllLenses(): void {
  const catTrack = document.getElementById('category-pill-track');
  const catActive = catTrack?.querySelector<HTMLElement>('[aria-pressed="true"]') || null;
  moveSlidingLens(catTrack, document.getElementById('category-lens'), catActive);

  const dockTrack = document.getElementById('floating-dock-track');
  const dockActive = dockTrack?.querySelector<HTMLElement>('[aria-current="page"]') || null;
  moveSlidingLens(dockTrack, document.getElementById('dock-lens'), dockActive);

  const contactTrack = document.getElementById('contact-pill-track');
  const contactActive = contactTrack?.querySelector<HTMLElement>('[aria-pressed="true"]') || null;
  moveSlidingLens(contactTrack, document.getElementById('contact-lens'), contactActive);

  const adminTrack = document.getElementById('admin-pill-track');
  const adminActive = adminTrack?.querySelector<HTMLElement>('[aria-selected="true"]') || null;
  moveSlidingLens(adminTrack, document.getElementById('admin-lens'), adminActive);
}

function syncEffectiveProducts(): void {
  if (!state.settingsReady && !state.firestoreProductsReady) {
    state.products = DEFAULT_PRODUCTS.map((p) => ({ ...p, colors: [...p.colors] }));
  } else {
    state.products = resolveInitialProducts(
      state.firestoreProductsReady ? state.firestoreProducts : null,
      DEFAULT_PRODUCTS.map((p) => ({ ...p, colors: [...p.colors] })),
      state.catalogInitialized
    );
  }

  state.products.forEach((p) => {
    if (!state.selectedColorsByProduct[p.id]) {
      state.selectedColorsByProduct[p.id] = (p.colors && p.colors[0]) || 'Matte Black';
    }
  });
}

function toIsoTimestamp(val: unknown): string {
  if (val instanceof Timestamp) {
    return val.toDate().toISOString();
  }
  if (typeof val === 'string' && val) return val;
  return new Date().toISOString();
}

function showAdminFeedback(message: string, isError = false): void {
  const fb = document.getElementById('admin-settings-feedback');
  if (!fb) return;
  fb.textContent = message;
  fb.hidden = false;
  fb.style.borderColor = isError ? 'rgba(248, 113, 113, 0.45)' : 'rgba(56, 189, 248, 0.30)';
  fb.style.background = isError ? 'rgba(248, 113, 113, 0.14)' : 'rgba(56, 189, 248, 0.12)';
}

function startPublicFirestoreSync(): void {
  if (!unsubSettings) {
    unsubSettings = onSnapshot(
      doc(db, 'settings', 'public'),
      (snap) => {
        state.settingsReady = true;
        if (snap.exists()) {
          const data = snap.data();
          state.catalogInitialized = Boolean(data.catalogInitialized);
          state.settings = {
            ntfyTopic: String(data.ntfyTopic || DEFAULT_SETTINGS.ntfyTopic),
            demoVideoUrl: String(data.demoVideoUrl || ''),
          };
        } else {
          state.catalogInitialized = false;
          state.settings = { ...DEFAULT_SETTINGS };
        }
        syncEffectiveProducts();
        renderCatalog(false);
        renderOptionalVideoSection();
        renderAdminSettings();
        if (state.activeProductId) {
          const activeProd = state.products.find((p) => p.id === state.activeProductId);
          if (activeProd) renderProductDetailContent(activeProd);
        }
      },
      (error) => {
        try {
          handleFirestoreError(error, OperationType.GET, 'settings/public');
        } catch {
          // Keep page resilient after logging structured FirestoreErrorInfo
        }
      }
    );
  }

  if (!unsubProducts) {
    unsubProducts = onSnapshot(
      query(collection(db, 'products'), orderBy('sortOrder', 'asc')),
      (snapshot) => {
        state.firestoreProductsReady = true;
        state.firestoreProducts = snapshot.docs.map((docSnap, idx) => {
          const d = docSnap.data();
          return {
            id: String(d.id || docSnap.id),
            title: String(d.title || ''),
            price: Number(d.price || 0),
            category: (d.category as PrintCategory) || 'Fidgets',
            description: String(d.description || ''),
            imageUrl: normalizeAssetUrl(String(d.imageUrl || '')),
            inStock: Boolean(d.inStock),
            colors: Array.isArray(d.colors) && d.colors.length > 0 ? d.colors.map(String) : ['Matte Black'],
            sortOrder: typeof d.sortOrder === 'number' ? d.sortOrder : idx,
          };
        });
        syncEffectiveProducts();
        renderCatalog(false);
        renderAdminProducts();
        if (state.activeProductId) {
          const activeProd = state.products.find((p) => p.id === state.activeProductId);
          if (activeProd) {
            renderProductDetailContent(activeProd);
          } else {
            closeProductPage('catalog');
          }
        }
      },
      (error) => {
        try {
          handleFirestoreError(error, OperationType.LIST, 'products');
        } catch {
          // Keep storefront resilient after logging structured FirestoreErrorInfo
        }
      }
    );
  }
}

function syncAdminOrdersSubscription(user: User | null): void {
  if (unsubOrders) {
    unsubOrders();
    unsubOrders = null;
  }

  if (!isVerifiedOwnerAdmin(user)) {
    state.orders = [];
    renderAdminOrders();
    return;
  }

  unsubOrders = onSnapshot(
    query(collection(db, 'orders'), orderBy('createdAt', 'desc')),
    (snapshot) => {
      state.orders = snapshot.docs.map((docSnap) => {
        const d = docSnap.data();
        return {
          id: String(d.id || docSnap.id),
          productId: String(d.productId || ''),
          productTitle: String(d.productTitle || ''),
          unitPrice: Number(d.unitPrice || 0),
          colorName: String(d.colorName || 'Matte Black'),
          quantity: Number(d.quantity || 1),
          totalPrice: Number(d.totalPrice || 0),
          buyerName: String(d.buyerName || ''),
          contactMethod: (d.contactMethod as ContactMethod) || 'Phone',
          contact: String(d.contact || ''),
          notes: String(d.notes || ''),
          createdAt: toIsoTimestamp(d.createdAt),
          status: d.status === 'Completed' ? 'Completed' : 'Pending',
          ntfySent: Boolean(d.ntfySent),
        };
      });
      renderAdminOrders();
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, 'orders');
      } catch {
        // Logged structured FirestoreErrorInfo
      }
    }
  );
}

async function ensureCatalogInitializedInFirestore(): Promise<void> {
  if (!isVerifiedOwnerAdmin(state.currentUser)) return;
  try {
    const settingsRef = doc(db, 'settings', 'public');
    const snap = await getDoc(settingsRef);
    if (snap.exists() && snap.data()?.catalogInitialized === true) {
      return;
    }

    const batch = writeBatch(db);
    DEFAULT_PRODUCTS.forEach((product, idx) => {
      batch.set(doc(db, 'products', product.id), {
        id: product.id,
        title: product.title.slice(0, BLUEPRINT_LIMITS.titleMaxLength),
        price: product.price,
        category: product.category,
        description: product.description.slice(0, BLUEPRINT_LIMITS.descriptionMaxLength),
        imageUrl: normalizeAssetUrl(product.imageUrl),
        inStock: product.inStock,
        colors: product.colors.slice(0, BLUEPRINT_LIMITS.maxColors),
        sortOrder: idx,
        updatedAt: serverTimestamp(),
      });
    });
    batch.set(settingsRef, {
      ntfyTopic: state.settings.ntfyTopic.slice(0, BLUEPRINT_LIMITS.ntfyTopicMaxLength) || DEFAULT_SETTINGS.ntfyTopic,
      demoVideoUrl: (state.settings.demoVideoUrl || '').slice(0, BLUEPRINT_LIMITS.demoVideoUrlMaxLength),
      catalogInitialized: true,
      updatedAt: serverTimestamp(),
    });
    await batch.commit();
  } catch (error) {
    try {
      handleFirestoreError(error, OperationType.WRITE, 'settings/public');
    } catch {
      // Logged structured FirestoreErrorInfo
    }
  }
}

function updateAdminAuthUI(): void {
  const gate = document.getElementById('admin-auth-gate');
  const workspace = document.getElementById('admin-workspace');
  const authDesc = document.getElementById('admin-auth-desc');
  const signInBtn = document.getElementById('admin-google-signin-btn');
  const switchBtn = document.getElementById('admin-signout-switch-btn');
  const statusEmail = document.getElementById('admin-signed-in-email');
  const errEl = document.getElementById('admin-auth-error');

  if (!gate || !workspace) return;

  const user = state.currentUser;
  const isAdmin = isVerifiedOwnerAdmin(user);

  if (isAdmin && user) {
    gate.hidden = true;
    workspace.hidden = false;
    if (statusEmail) statusEmail.textContent = user.email || OWNER_ADMIN_EMAIL;
    if (errEl) errEl.hidden = true;
    window.requestAnimationFrame(syncAllLenses);
  } else {
    gate.hidden = false;
    workspace.hidden = true;
    if (user) {
      if (authDesc) {
        authDesc.textContent = `Signed in as ${user.email || 'another account'}, which does not have owner edit access. Sign in with ${OWNER_ADMIN_EMAIL} to manage products, orders, and settings.`;
      }
      if (signInBtn) signInBtn.textContent = 'Switch Google Account';
      if (switchBtn) switchBtn.hidden = false;
    } else {
      if (authDesc) {
        authDesc.textContent = `Sign in with your owner Google account (${OWNER_ADMIN_EMAIL}) so every change you make saves to the database and syncs live for everyone.`;
      }
      if (signInBtn) signInBtn.textContent = 'Sign in with Google';
      if (switchBtn) switchBtn.hidden = true;
    }
  }
}

function renderCatalog(animateFlyIn = false): void {
  const grid = byId<HTMLElement>('product-grid');
  const countLabel = byId<HTMLElement>('catalog-count-label');
  const filtered = filterProducts(state.products, state.activeCategory, state.searchQuery, state.sortBy);

  countLabel.textContent =
    state.products.length === 0
      ? 'No prints listed right now'
      : `Showing ${filtered.length} ${filtered.length === 1 ? 'print' : 'prints'} · Click any card to view & order`;

  if (state.products.length === 0) {
    grid.innerHTML = `
      <div class="empty-catalog liquid-glass fly-in">
        <h3 style="font-size:1.1rem;margin-bottom:6px;">No prints available right now</h3>
        <p style="font-size:0.9rem;color:var(--text-secondary);">Check back soon—items added in the admin panel appear here automatically.</p>
      </div>
    `;
    return;
  }

  if (filtered.length === 0) {
    grid.innerHTML = `
      <div class="empty-catalog liquid-glass fly-in">
        <h3 style="font-size:1.1rem;margin-bottom:6px;">No matching prints found</h3>
        <p style="font-size:0.9rem;color:var(--text-secondary);margin-bottom:16px;">Try clearing your search or switching categories.</p>
        <button type="button" id="reset-filter-btn" class="glass-btn">Show All Prints</button>
      </div>
    `;
    const resetBtn = document.getElementById('reset-filter-btn');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        state.activeCategory = 'All';
        state.sortBy = 'default';
        state.searchQuery = '';
        byId<HTMLInputElement>('catalog-search').value = '';
        byId<HTMLSelectElement>('catalog-sort').value = 'default';
        updateFilterButtonsUI();
        renderCatalog(true);
      });
    }
    return;
  }

  grid.innerHTML = filtered
    .map((product, index) => {
      const colors = Array.isArray(product.colors) && product.colors.length > 0 ? product.colors : ['Matte Black'];
      const activeColor = colors.includes(state.selectedColorsByProduct[product.id])
        ? state.selectedColorsByProduct[product.id]
        : colors[0];
      state.selectedColorsByProduct[product.id] = activeColor;
      const activeHex = getColorHex(activeColor);

      const safeUrl = normalizeAssetUrl(product.imageUrl);
      const mediaHtml = safeUrl
        ? `<img src="${escapeHtml(safeUrl)}" alt="${escapeHtml(product.title)}" referrerpolicy="no-referrer" data-fallback-title="${escapeHtml(product.title)}" data-fallback-hex="${escapeHtml(activeHex)}" />`
        : createSvgFallbackMarkup(product.title, activeHex);

      const swatchesHtml = colors
        .map((colorName) => {
          const hex = getColorHex(colorName);
          const isSelected = colorName === activeColor;
          return `
            <button
              type="button"
              class="swatch-btn"
              data-action="select-swatch"
              data-product-id="${escapeHtml(product.id)}"
              data-color="${escapeHtml(colorName)}"
              aria-label="Select ${escapeHtml(colorName)} for ${escapeHtml(product.title)}"
              aria-pressed="${isSelected ? 'true' : 'false'}"
              title="${escapeHtml(colorName)}"
            >
              <span class="swatch-circle" style="background:${hex};"></span>
            </button>
          `;
        })
        .join('');

      const animClass = animateFlyIn ? 'fly-in' : '';
      const delayMs = 150 + index * 55;

      return `
        <article
          class="product-card liquid-glass liquid-interactive ${animClass}"
          style="--delay:${delayMs}ms;"
          data-product-id="${escapeHtml(product.id)}"
          data-action="open-product"
        >
          <div class="card-media">
            ${mediaHtml}
          </div>
          <div class="card-body">
            <div class="card-meta-line">
              <span>${escapeHtml(product.category)}</span>
              <span aria-hidden="true">·</span>
              <span class="${product.inStock ? 'stock-label-in' : 'stock-label-out'}">
                ${product.inStock ? 'In Stock' : 'Out of Stock'}
              </span>
            </div>

            <h3 class="card-title">${escapeHtml(product.title)}</h3>
            <p class="card-desc">${escapeHtml(product.description)}</p>

            <div class="swatch-section">
              <div class="swatch-active-text">
                <span>Color:</span>
                <span style="width:10px;height:10px;border-radius:50%;background:${activeHex};display:inline-block;border:1px solid rgba(255,255,255,0.4);"></span>
                <span class="swatch-active-name">${escapeHtml(activeColor)}</span>
              </div>
              <div class="swatch-list" role="group" aria-label="Color options for ${escapeHtml(product.title)}">
                ${swatchesHtml}
              </div>
            </div>

            <div class="card-footer">
              <span class="card-price">${formatCurrency(product.price)}</span>
              <button
                type="button"
                class="glass-btn ${product.inStock ? 'glass-btn-accent' : ''}"
                style="min-height:36px;padding:7px 16px;font-size:0.82rem;"
                data-action="open-product"
                data-product-id="${escapeHtml(product.id)}"
                aria-label="${product.inStock ? `Customize and request ${escapeHtml(product.title)}` : `View ${escapeHtml(product.title)}`}"
              >
                ${product.inStock ? 'Customize & Order' : 'Out of Stock'}
              </button>
            </div>
          </div>
        </article>
      `;
    })
    .join('');

  grid.querySelectorAll<HTMLImageElement>('img[data-fallback-title]').forEach((img) => {
    img.addEventListener('error', () => {
      const title = img.getAttribute('data-fallback-title') || '3D Print';
      const hex = img.getAttribute('data-fallback-hex') || '#38bdf8';
      img.outerHTML = createSvgFallbackMarkup(title, hex);
    });
  });
}

function openProductPage(productId: string, pushHash = true): void {
  const product = state.products.find((p) => p.id === productId);
  if (!product) return;

  state.activeProductId = product.id;
  state.detailZoomed = false;
  byId('detail-main-frame').classList.remove('is-zoomed');

  byId('storefront-view').hidden = true;
  const detailView = byId('product-detail-view');
  detailView.hidden = false;

  detailView.style.animation = 'none';
  void detailView.offsetHeight;
  detailView.style.animation = '';

  byId('detail-form-container').hidden = false;
  byId('order-receipt-container').hidden = true;
  byId<HTMLFormElement>('order-form').reset();
  byId<HTMLInputElement>('order-qty-input').value = '1';
  setContactMethod(state.contactMethod || 'Phone');
  clearOrderFormErrors();

  renderProductDetailContent(product);
  window.scrollTo({ top: 0, behavior: 'smooth' });

  if (pushHash) {
    history.replaceState(null, '', `#item/${encodeURIComponent(product.id)}`);
  }
  window.requestAnimationFrame(syncAllLenses);
}

function closeProductPage(targetSection: string | null = null): void {
  state.activeProductId = null;
  byId('product-detail-view').hidden = true;
  byId('storefront-view').hidden = false;

  if (window.location.hash.startsWith('#item/')) {
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  if (targetSection) {
    const el = document.getElementById(targetSection);
    if (el) el.scrollIntoView({ behavior: 'smooth' });
  } else {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  window.requestAnimationFrame(syncAllLenses);
}

function renderProductDetailContent(product: PrintProduct): void {
  const colors = Array.isArray(product.colors) && product.colors.length > 0 ? product.colors : ['Matte Black'];
  const activeColor = colors.includes(state.selectedColorsByProduct[product.id])
    ? state.selectedColorsByProduct[product.id]
    : colors[0];
  state.selectedColorsByProduct[product.id] = activeColor;
  const activeHex = getColorHex(activeColor);

  const imgEl = byId<HTMLImageElement>('detail-main-img');
  const fallbackEl = byId('detail-svg-fallback');
  const safeUrl = normalizeAssetUrl(product.imageUrl);
  if (safeUrl) {
    imgEl.src = safeUrl;
    imgEl.alt = product.title;
    imgEl.hidden = false;
    fallbackEl.hidden = true;
    imgEl.onerror = () => {
      imgEl.hidden = true;
      fallbackEl.hidden = false;
      fallbackEl.innerHTML = createSvgFallbackMarkup(product.title, activeHex);
    };
  } else {
    imgEl.hidden = true;
    fallbackEl.hidden = false;
    fallbackEl.innerHTML = createSvgFallbackMarkup(product.title, activeHex);
  }

  byId('detail-active-color-dot').style.background = activeHex;
  byId('detail-active-color-name').textContent = activeColor;

  byId('detail-swatch-list').innerHTML = colors
    .map((c) => {
      const hex = getColorHex(c);
      return `
        <button
          type="button"
          class="swatch-btn"
          data-detail-color="${escapeHtml(c)}"
          aria-label="Choose ${escapeHtml(c)}"
          aria-pressed="${c === activeColor ? 'true' : 'false'}"
          title="${escapeHtml(c)}"
        >
          <span class="swatch-circle" style="background:${hex};"></span>
        </button>
      `;
    })
    .join('');

  byId('detail-meta-line').innerHTML = `
    <span>${escapeHtml(product.category)}</span>
    <span aria-hidden="true">·</span>
    <span class="${product.inStock ? 'stock-label-in' : 'stock-label-out'}">
      ${product.inStock ? 'In Stock' : 'Out of Stock'}
    </span>
  `;
  byId('detail-title').textContent = product.title;
  byId('detail-unit-price').textContent = formatCurrency(product.price);
  byId('detail-desc').textContent = product.description;

  const submitBtn = byId<HTMLButtonElement>('order-submit-btn');
  submitBtn.disabled = !product.inStock;
  submitBtn.textContent = product.inStock ? 'Request Print' : 'Out of Stock';

  syncDetailCashTotal(product);
}

function syncDetailCashTotal(product: PrintProduct | undefined): void {
  if (!product) return;
  const qtyInput = byId<HTMLInputElement>('order-qty-input');
  const qty = Math.max(1, Math.min(MAX_ORDER_QUANTITY, parseInt(qtyInput.value, 10) || 1));
  const total = calculateOrderTotal(product.price, qty);
  byId('order-cash-total').textContent = formatCurrency(total);
}

function setContactMethod(method: ContactMethod): void {
  if (!CONTACT_HINTS[method]) return;
  state.contactMethod = method;
  const track = byId('contact-pill-track');
  track.querySelectorAll<HTMLElement>('.pill-tab-btn').forEach((btn) => {
    const isMatch = btn.getAttribute('data-contact-method') === method;
    btn.setAttribute('aria-pressed', isMatch ? 'true' : 'false');
    if (isMatch) {
      moveSlidingLens(track, document.getElementById('contact-lens'), btn);
    }
  });
  const input = byId<HTMLInputElement>('order-contact');
  input.placeholder = CONTACT_HINTS[method];
  input.type = method === 'Email' ? 'email' : method === 'Phone' ? 'tel' : 'text';
}

function clearOrderFormErrors(): void {
  ['err-buyer-name', 'err-contact', 'err-qty', 'err-product-stock'].forEach((id) => {
    const el = byId(id);
    el.textContent = '';
    el.hidden = true;
  });
}

async function handleOrderSubmit(event: Event): Promise<void> {
  event.preventDefault();
  clearOrderFormErrors();

  const product = state.products.find((p) => p.id === state.activeProductId);
  const colorName = (product && state.selectedColorsByProduct[product.id]) || 'Matte Black';
  const buyerName = byId<HTMLInputElement>('order-buyer-name').value.trim();
  const contactMethod = state.contactMethod;
  const contact = byId<HTMLInputElement>('order-contact').value.trim();
  const qty = parseInt(byId<HTMLInputElement>('order-qty-input').value, 10);
  const notes = byId<HTMLTextAreaElement>('order-notes').value.trim().slice(0, BLUEPRINT_LIMITS.notesMaxLength);

  const validation = validateOrderInput({
    buyerName,
    contactMethod,
    contact,
    quantity: qty,
    productInStock: Boolean(product && product.inStock),
  });

  if (!validation.valid) {
    if (validation.errors.product) {
      const el = byId('err-product-stock');
      el.textContent = validation.errors.product;
      el.hidden = false;
    }
    if (validation.errors.buyerName) {
      const el = byId('err-buyer-name');
      el.textContent = validation.errors.buyerName;
      el.hidden = false;
    }
    if (validation.errors.contact) {
      const el = byId('err-contact');
      el.textContent = validation.errors.contact;
      el.hidden = false;
    }
    if (validation.errors.quantity) {
      const el = byId('err-qty');
      el.textContent = validation.errors.quantity;
      el.hidden = false;
    }
    return;
  }

  if (!product) return;

  const submitBtn = byId<HTMLButtonElement>('order-submit-btn');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Sending Request...';

  const totalPrice = calculateOrderTotal(product.price, qty);
  const orderId = `ORD-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
  const order: PrintOrder = {
    id: orderId,
    productId: product.id,
    productTitle: product.title.slice(0, BLUEPRINT_LIMITS.productTitleOrderMaxLength),
    unitPrice: product.price,
    colorName: colorName.slice(0, 60),
    quantity: qty,
    totalPrice,
    buyerName: buyerName.slice(0, BLUEPRINT_LIMITS.buyerNameMaxLength),
    contactMethod,
    contact: contact.slice(0, BLUEPRINT_LIMITS.contactMaxLength),
    notes,
    createdAt: new Date().toISOString(),
    status: 'Pending',
    ntfySent: false,
  };

  try {
    const ntfyPayload = buildNtfyPayload(order, state.settings.ntfyTopic);
    const sent = await sendNtfyNotification(ntfyPayload.url, ntfyPayload.headers, ntfyPayload.body);
    order.ntfySent = sent;

    // Ensure catalog is initialized if customer orders from default unseeded item? No—rules require product doc to exist!
    // Write order document to Firestore with serverTimestamp()
    await setDoc(doc(db, 'orders', orderId), {
      id: order.id,
      productId: order.productId,
      productTitle: order.productTitle,
      unitPrice: order.unitPrice,
      colorName: order.colorName,
      quantity: order.quantity,
      totalPrice: order.totalPrice,
      buyerName: order.buyerName,
      contactMethod: order.contactMethod,
      contact: order.contact,
      notes: order.notes,
      status: 'Pending',
      ntfySent: order.ntfySent,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    showOrderReceipt(order);
  } catch (error) {
    const errEl = byId('err-product-stock');
    errEl.textContent =
      'Could not save your order to the database right now. Make sure the store catalog is initialized and this item is in stock.';
    errEl.hidden = false;
    try {
      handleFirestoreError(error, OperationType.CREATE, `orders/${orderId}`);
    } catch {
      // Structured FirestoreErrorInfo logged
    }
  } finally {
    submitBtn.disabled = !product.inStock;
    submitBtn.textContent = product.inStock ? 'Request Print' : 'Out of Stock';
  }
}

function showOrderReceipt(order: PrintOrder): void {
  byId('detail-form-container').hidden = true;
  byId('order-receipt-container').hidden = false;
  byId('receipt-order-id').textContent = order.id;
  byId('receipt-ntfy-status').textContent = order.ntfySent
    ? 'Request sent. I will reach out once it is ready so you can pay full cash in person.'
    : 'Request saved. Please bring the full amount in cash only when we meet in person (no refunds).';

  byId('receipt-rows').innerHTML = `
    <div class="receipt-row"><span>Print Item</span><strong>${order.quantity}x ${escapeHtml(order.productTitle)}</strong></div>
    <div class="receipt-row"><span>Color</span><strong>${escapeHtml(order.colorName)}</strong></div>
    <div class="receipt-row"><span>Buyer</span><strong>${escapeHtml(order.buyerName)}</strong></div>
    <div class="receipt-row"><span>${escapeHtml(order.contactMethod)}</span><strong>${escapeHtml(order.contact)}</strong></div>
    ${order.notes ? `<div class="receipt-row"><span>Notes</span><strong>${escapeHtml(order.notes)}</strong></div>` : ''}
    <div class="receipt-row"><span>Full Cash Due In Person</span><strong style="font-family:var(--font-mono);color:var(--accent-cyan);">${formatCurrency(order.totalPrice)}</strong></div>
  `;
}

function renderOptionalVideoSection(): void {
  const section = byId('custom-video-section');
  const frame = byId('custom-video-frame');
  const customUrl = (state.settings.demoVideoUrl || '').trim();

  const ytEmbed = extractYouTubeEmbedUrl(customUrl);
  if (ytEmbed) {
    section.hidden = false;
    frame.innerHTML = `<iframe src="${escapeHtml(ytEmbed)}" title="Product preview video" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>`;
    return;
  }

  if (customUrl && /\.(mp4|webm|ogg)(\?|$)/i.test(customUrl)) {
    section.hidden = false;
    frame.innerHTML = `<video src="${escapeHtml(customUrl)}" controls playsinline muted loop aria-label="Product preview video"></video>`;
    return;
  }

  section.hidden = true;
  frame.innerHTML = '';
}

function updateFilterButtonsUI(): void {
  const track = byId('category-pill-track');
  track.querySelectorAll<HTMLElement>('.pill-tab-btn').forEach((btn) => {
    const isMatch = btn.getAttribute('data-category') === state.activeCategory;
    btn.setAttribute('aria-pressed', isMatch ? 'true' : 'false');
    if (isMatch) {
      moveSlidingLens(track, document.getElementById('category-lens'), btn);
    }
  });
}

function setDockActive(targetName: string): void {
  state.activeDockTarget = targetName;
  const dockTrack = byId('floating-dock-track');
  dockTrack.querySelectorAll<HTMLElement>('.dock-item').forEach((btn) => {
    const isMatch = btn.getAttribute('data-dock-target') === targetName;
    if (isMatch) {
      btn.setAttribute('aria-current', 'page');
      moveSlidingLens(dockTrack, document.getElementById('dock-lens'), btn);
    } else {
      btn.removeAttribute('aria-current');
    }
  });
}

/* Admin Panel */
function openAdminPanel(): void {
  const backdrop = byId('admin-modal-backdrop');
  backdrop.classList.add('is-open');
  backdrop.setAttribute('aria-hidden', 'false');
  state.pendingDeleteProductId = null;
  resetAdminProductForm();
  updateAdminAuthUI();
  renderAdminProducts();
  renderAdminOrders();
  renderAdminSettings();
  window.requestAnimationFrame(syncAllLenses);
}

function closeAdminPanel(): void {
  const backdrop = byId('admin-modal-backdrop');
  backdrop.classList.remove('is-open');
  backdrop.setAttribute('aria-hidden', 'true');
  if (window.location.hash === '#admin') {
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }
}

function switchAdminTab(tabName: string): void {
  state.adminActiveTab = tabName;
  const track = byId('admin-pill-track');
  track.querySelectorAll<HTMLElement>('.pill-tab-btn').forEach((btn) => {
    const isMatch = btn.getAttribute('data-admin-tab') === tabName;
    btn.setAttribute('aria-selected', isMatch ? 'true' : 'false');
    if (isMatch) {
      moveSlidingLens(track, document.getElementById('admin-lens'), btn);
    }
  });
  byId('admin-tab-products').hidden = tabName !== 'products';
  byId('admin-tab-orders').hidden = tabName !== 'orders';
  byId('admin-tab-settings').hidden = tabName !== 'settings';
}

function renderAdminColorCheckboxes(selectedColors: string[]): void {
  const container = byId('admin-color-checkboxes');
  container.innerHTML = FILAMENT_PALETTE.map(
    (c) => `
      <label class="color-check-label">
        <input type="checkbox" name="admin-colors" value="${escapeHtml(c.name)}" ${selectedColors.includes(c.name) ? 'checked' : ''} />
        <span style="width:12px;height:12px;border-radius:50%;background:${c.hex};display:inline-block;border:1px solid rgba(255,255,255,0.3);"></span>
        <span>${escapeHtml(c.name)}</span>
      </label>
    `
  ).join('');
}

function resetAdminProductForm(): void {
  byId<HTMLFormElement>('admin-product-form').reset();
  byId<HTMLInputElement>('admin-edit-id').value = '';
  byId('admin-form-heading').textContent = 'Add New Print Item';
  byId('admin-save-prod-btn').textContent = 'Add Product';
  byId('admin-cancel-edit-btn').hidden = true;
  byId<HTMLInputElement>('admin-prod-instock').checked = true;
  byId('admin-prod-error').hidden = true;
  renderAdminColorCheckboxes(FILAMENT_PALETTE.slice(0, 4).map((c) => c.name));
}

function renderAdminProducts(): void {
  const list = byId('admin-products-list');
  if (state.products.length === 0) {
    list.innerHTML = '<p style="color:var(--text-muted);font-size:0.88rem;">No products in catalog yet.</p>';
    return;
  }

  list.innerHTML = state.products
    .map((p) => {
      const isPendingDelete = state.pendingDeleteProductId === p.id;
      return `
        <div class="admin-item-row">
          <div style="min-width:200px;flex:1;">
            <div style="font-weight:600;font-size:0.95rem;">
              ${escapeHtml(p.title)}
              <span style="font-family:var(--font-mono);color:var(--accent-cyan);margin-left:8px;">${formatCurrency(p.price)}</span>
            </div>
            <div style="font-size:0.8rem;color:var(--text-muted);margin-top:2px;">
              ${escapeHtml(p.category)} · ${p.inStock ? 'In Stock' : 'Out of Stock'} · ${(p.colors || []).length} colors
            </div>
          </div>
          <div class="admin-item-actions">
            <button
              type="button"
              class="glass-btn"
              style="min-height:36px;padding:6px 14px;font-size:0.8rem;"
              data-admin-action="toggle-stock"
              data-id="${escapeHtml(p.id)}"
            >
              ${p.inStock ? 'Mark Out of Stock' : 'Mark In Stock'}
            </button>
            <button
              type="button"
              class="glass-btn"
              style="min-height:36px;padding:6px 14px;font-size:0.8rem;"
              data-admin-action="edit-product"
              data-id="${escapeHtml(p.id)}"
            >
              Edit
            </button>
            <button
              type="button"
              class="glass-btn glass-btn-danger"
              style="min-height:36px;padding:6px 14px;font-size:0.8rem;"
              data-admin-action="delete-product"
              data-id="${escapeHtml(p.id)}"
            >
              ${isPendingDelete ? 'Confirm Delete' : 'Delete'}
            </button>
          </div>
        </div>
      `;
    })
    .join('');
}

function renderAdminOrders(): void {
  byId('admin-orders-count').textContent = String(state.orders.length);
  const list = byId('admin-orders-list');

  if (state.orders.length === 0) {
    list.innerHTML = '<p style="color:var(--text-muted);font-size:0.88rem;padding:12px 0;">No print orders submitted yet.</p>';
    return;
  }

  list.innerHTML = state.orders
    .map((order) => {
      const parsedDate = order.createdAt ? new Date(order.createdAt) : null;
      const dateLabel =
        parsedDate && !Number.isNaN(parsedDate.getTime())
          ? parsedDate.toLocaleString(undefined, {
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            })
          : 'Just now';
      return `
        <div class="admin-item-row">
          <div style="flex:1;min-width:220px;">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
              <strong style="font-size:0.94rem;">${order.quantity}x ${escapeHtml(order.productTitle)}</strong>
              <span style="font-family:var(--font-mono);font-size:0.82rem;color:var(--accent-cyan);">${formatCurrency(order.totalPrice)}</span>
              <span style="font-size:0.78rem;font-weight:600;color:${order.status === 'Completed' ? 'var(--accent-emerald)' : 'var(--warning)'};">
                ${escapeHtml(order.status)}
              </span>
            </div>
            <div style="font-size:0.82rem;color:var(--text-secondary);margin-top:4px;">
              Buyer: ${escapeHtml(order.buyerName)} · ${escapeHtml(order.contactMethod || 'Contact')}: ${escapeHtml(order.contact)} · Color: ${escapeHtml(order.colorName)}
            </div>
            ${order.notes ? `<div style="font-size:0.8rem;color:var(--text-muted);margin-top:2px;">Note: ${escapeHtml(order.notes)}</div>` : ''}
            <div style="font-size:0.75rem;color:var(--text-muted);margin-top:4px;">
              ${escapeHtml(order.id)} · ${escapeHtml(dateLabel)} · ${order.ntfySent ? 'ntfy alert sent' : 'Saved in Firestore'}
            </div>
          </div>
          <div class="admin-item-actions">
            <button
              type="button"
              class="glass-btn"
              style="min-height:36px;padding:6px 14px;font-size:0.8rem;"
              data-admin-action="toggle-order-status"
              data-id="${escapeHtml(order.id)}"
            >
              ${order.status === 'Completed' ? 'Reopen' : 'Mark Handed Off'}
            </button>
          </div>
        </div>
      `;
    })
    .join('');
}

function renderAdminSettings(): void {
  const topicInput = document.getElementById('admin-ntfy-topic') as HTMLInputElement | null;
  const videoInput = document.getElementById('admin-demo-video') as HTMLInputElement | null;
  if (topicInput) topicInput.value = state.settings.ntfyTopic;
  if (videoInput) videoInput.value = state.settings.demoVideoUrl || '';
}

function setupScrollReveals(): void {
  const targets = document.querySelectorAll('.scroll-reveal');
  if (!('IntersectionObserver' in window)) {
    targets.forEach((el) => el.classList.add('is-visible'));
    return;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.08, rootMargin: '0px 0px -20px 0px' }
  );
  targets.forEach((el) => observer.observe(el));
}

function bindPointerRefraction(): void {
  const prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReduced) return;

  document.addEventListener(
    'pointermove',
    (e) => {
      const target = (e.target as HTMLElement | null)?.closest<HTMLElement>('.liquid-interactive');
      if (!target) return;
      const rect = target.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / Math.max(1, rect.width)) * 100;
      const y = ((e.clientY - rect.top) / Math.max(1, rect.height)) * 100;
      target.style.setProperty('--gx', `${x.toFixed(1)}%`);
      target.style.setProperty('--gy', `${y.toFixed(1)}%`);
    },
    { passive: true }
  );
}

function handleHashRoute(): void {
  const hash = window.location.hash;
  if (hash === '#admin') {
    openAdminPanel();
    return;
  }
  const adminBackdrop = document.getElementById('admin-modal-backdrop');
  if (adminBackdrop && adminBackdrop.classList.contains('is-open')) {
    closeAdminPanel();
  }
  if (hash.startsWith('#item/')) {
    let id = '';
    try {
      id = decodeURIComponent(hash.slice('#item/'.length));
    } catch {
      return;
    }
    if (state.products.some((p) => p.id === id)) {
      openProductPage(id, false);
    }
    return;
  }
  if (state.activeProductId) {
    closeProductPage(hash ? hash.slice(1) : null);
  }
}

async function handleGoogleAdminSignIn(): Promise<void> {
  const errEl = byId('admin-auth-error');
  const btn = byId<HTMLButtonElement>('admin-google-signin-btn');
  errEl.hidden = true;
  btn.disabled = true;
  try {
    await signInWithPopup(auth, googleProvider);
  } catch (error) {
    const code = (error as { code?: string })?.code || '';
    if (code === 'auth/unauthorized-domain') {
      errEl.textContent = `Domain "${window.location.hostname}" is not authorized yet in Firebase Auth. Add it under Firebase Console → Authentication → Settings → Authorized domains.`;
    } else if (code !== 'auth/popup-closed-by-user') {
      errEl.textContent = error instanceof Error ? error.message : 'Google sign-in failed.';
    }
    if (errEl.textContent) errEl.hidden = false;
  } finally {
    btn.disabled = false;
  }
}

function bindEvents(): void {
  bindPointerRefraction();
  window.addEventListener('resize', syncAllLenses);

  // Floating Liquid Glass Dock
  byId('floating-dock-track').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement | null)?.closest<HTMLElement>('.dock-item');
    if (!btn) return;
    const target = btn.getAttribute('data-dock-target') || 'home';
    setDockActive(target);

    if (target === 'home') {
      if (state.activeProductId) closeProductPage(null);
      else window.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (target === 'catalog') {
      if (state.activeProductId) closeProductPage('catalog');
      else byId('catalog').scrollIntoView({ behavior: 'smooth' });
    } else if (target === 'pickup') {
      if (state.activeProductId) closeProductPage('pickup');
      else byId('pickup').scrollIntoView({ behavior: 'smooth' });
    } else if (target === 'search') {
      if (state.activeProductId) closeProductPage('catalog');
      window.setTimeout(() => {
        const input = byId<HTMLInputElement>('catalog-search');
        input.scrollIntoView({ behavior: 'smooth', block: 'center' });
        input.focus();
      }, 140);
    }
  });

  // Category Filter Pills
  byId('category-pill-track').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement | null)?.closest<HTMLElement>('.pill-tab-btn');
    if (!btn) return;
    state.activeCategory = btn.getAttribute('data-category') || 'All';
    updateFilterButtonsUI();
    renderCatalog(false);
  });

  // Sort Dropdown
  byId<HTMLSelectElement>('catalog-sort').addEventListener('change', (e) => {
    state.sortBy = ((e.target as HTMLSelectElement).value as SortOption) || 'default';
    renderCatalog(false);
  });

  // Search
  byId<HTMLInputElement>('catalog-search').addEventListener('input', (e) => {
    state.searchQuery = (e.target as HTMLInputElement).value;
    renderCatalog(false);
  });

  // Product Grid Click & Swatches
  byId('product-grid').addEventListener('click', (e) => {
    const swatchBtn = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-action="select-swatch"]');
    if (swatchBtn) {
      e.stopPropagation();
      const productId = swatchBtn.getAttribute('data-product-id');
      const color = swatchBtn.getAttribute('data-color');
      if (productId && color) {
        state.selectedColorsByProduct[productId] = color;
        renderCatalog(false);
      }
      return;
    }

    const opener = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-action="open-product"]');
    if (opener) {
      const productId = opener.getAttribute('data-product-id');
      if (productId) openProductPage(productId);
    }
  });

  // Product Detail Page Events
  byId('detail-back-btn').addEventListener('click', () => closeProductPage('catalog'));
  byId('receipt-done-btn').addEventListener('click', () => closeProductPage('catalog'));
  byId('receipt-new-btn').addEventListener('click', () => {
    if (state.activeProductId) openProductPage(state.activeProductId, false);
  });

  byId('detail-zoom-btn').addEventListener('click', () => {
    state.detailZoomed = !state.detailZoomed;
    byId('detail-main-frame').classList.toggle('is-zoomed', state.detailZoomed);
  });

  byId('detail-swatch-list').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-detail-color]');
    if (!btn || !state.activeProductId) return;
    const color = btn.getAttribute('data-detail-color');
    if (!color) return;
    state.selectedColorsByProduct[state.activeProductId] = color;
    const product = state.products.find((p) => p.id === state.activeProductId);
    if (product) renderProductDetailContent(product);
    renderCatalog(false);
  });

  byId('contact-pill-track').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-contact-method]');
    if (!btn) return;
    const method = btn.getAttribute('data-contact-method') as ContactMethod | null;
    if (method) setContactMethod(method);
  });

  byId('qty-dec').addEventListener('click', () => {
    const input = byId<HTMLInputElement>('order-qty-input');
    const errEl = byId('err-qty');
    input.value = String(Math.max(1, (parseInt(input.value, 10) || 1) - 1));
    errEl.textContent = '';
    errEl.hidden = true;
    const product = state.products.find((p) => p.id === state.activeProductId);
    syncDetailCashTotal(product);
  });

  byId('qty-inc').addEventListener('click', () => {
    const input = byId<HTMLInputElement>('order-qty-input');
    const errEl = byId('err-qty');
    const current = parseInt(input.value, 10) || 1;
    if (current >= MAX_ORDER_QUANTITY) {
      input.value = String(MAX_ORDER_QUANTITY);
      errEl.textContent = 'gng, how much do u need? 🥀';
      errEl.hidden = false;
    } else {
      input.value = String(current + 1);
      errEl.textContent = '';
      errEl.hidden = true;
    }
    const product = state.products.find((p) => p.id === state.activeProductId);
    syncDetailCashTotal(product);
  });

  byId<HTMLInputElement>('order-qty-input').addEventListener('input', () => {
    const input = byId<HTMLInputElement>('order-qty-input');
    const errEl = byId('err-qty');
    const parsed = parseInt(input.value, 10);
    if (Number.isInteger(parsed) && parsed > MAX_ORDER_QUANTITY) {
      input.value = String(MAX_ORDER_QUANTITY);
      errEl.textContent = 'gng, how much do u need? 🥀';
      errEl.hidden = false;
    } else {
      errEl.textContent = '';
      errEl.hidden = true;
    }
    const product = state.products.find((p) => p.id === state.activeProductId);
    syncDetailCashTotal(product);
  });

  byId<HTMLFormElement>('order-form').addEventListener('submit', handleOrderSubmit);

  // Hash & Secret Admin Panel
  window.addEventListener('hashchange', handleHashRoute);

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      const isOpen = byId('admin-modal-backdrop').classList.contains('is-open');
      if (isOpen) closeAdminPanel();
      else openAdminPanel();
      return;
    }
    if (e.key === 'Escape') {
      closeAdminPanel();
    }
  });

  byId('admin-modal-close').addEventListener('click', closeAdminPanel);
  byId('admin-modal-backdrop').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeAdminPanel();
  });

  byId('admin-google-signin-btn').addEventListener('click', () => {
    void handleGoogleAdminSignIn();
  });

  byId('admin-signout-btn').addEventListener('click', () => {
    void signOut(auth);
  });

  byId('admin-signout-switch-btn').addEventListener('click', () => {
    void signOut(auth);
  });

  byId('admin-pill-track').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-admin-tab]');
    if (!btn) return;
    const tab = btn.getAttribute('data-admin-tab');
    if (tab) switchAdminTab(tab);
  });

  byId('admin-cancel-edit-btn').addEventListener('click', resetAdminProductForm);

  byId<HTMLFormElement>('admin-product-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = byId('admin-prod-error');
    errEl.hidden = true;

    if (!isVerifiedOwnerAdmin(state.currentUser)) {
      errEl.textContent = 'Sign in with your owner Google account first.';
      errEl.hidden = false;
      return;
    }

    const editId = byId<HTMLInputElement>('admin-edit-id').value.trim();
    const title = byId<HTMLInputElement>('admin-prod-title').value.trim();
    const price = parseFloat(byId<HTMLInputElement>('admin-prod-price').value);
    const category = byId<HTMLSelectElement>('admin-prod-category').value as PrintCategory;
    const imageUrl = normalizeAssetUrl(byId<HTMLInputElement>('admin-prod-image').value);
    const description = byId<HTMLTextAreaElement>('admin-prod-desc').value.trim();
    const inStock = byId<HTMLInputElement>('admin-prod-instock').checked;
    const rawColors = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[name="admin-colors"]:checked')
    ).map((el) => el.value.slice(0, BLUEPRINT_LIMITS.colorMaxLength));

    const validation = validateProductInput({ title, price, category, description, imageUrl });
    if (!validation.valid) {
      errEl.textContent = Object.values(validation.errors)[0] || 'Please provide valid product fields.';
      errEl.hidden = false;
      return;
    }

    const finalColors = (rawColors.length > 0 ? rawColors : ['Matte Black', 'Silk Cyan']).slice(
      0,
      BLUEPRINT_LIMITS.maxColors
    );
    const saveBtn = byId<HTMLButtonElement>('admin-save-prod-btn');
    saveBtn.disabled = true;

    try {
      await ensureCatalogInitializedInFirestore();
      const roundedPrice = Math.round(price * 100) / 100;

      if (editId) {
        const existing = state.products.find((p) => p.id === editId);
        await updateDoc(doc(db, 'products', editId), {
          title: title.slice(0, BLUEPRINT_LIMITS.titleMaxLength),
          price: roundedPrice,
          category,
          description: description.slice(0, BLUEPRINT_LIMITS.descriptionMaxLength),
          imageUrl: imageUrl.slice(0, BLUEPRINT_LIMITS.imageUrlMaxLength),
          inStock,
          colors: finalColors,
          sortOrder: existing?.sortOrder ?? 0,
          updatedAt: serverTimestamp(),
        });
      } else {
        const newId = `print-${Date.now()}`;
        const nextSort = state.products.reduce((max, p) => Math.max(max, p.sortOrder ?? 0), -1) + 1;
        await setDoc(doc(db, 'products', newId), {
          id: newId,
          title: title.slice(0, BLUEPRINT_LIMITS.titleMaxLength),
          price: roundedPrice,
          category,
          description: description.slice(0, BLUEPRINT_LIMITS.descriptionMaxLength),
          imageUrl: imageUrl.slice(0, BLUEPRINT_LIMITS.imageUrlMaxLength),
          inStock,
          colors: finalColors,
          sortOrder: Math.min(100000, Math.max(0, nextSort)),
          updatedAt: serverTimestamp(),
        });
        state.selectedColorsByProduct[newId] = finalColors[0];
      }

      resetAdminProductForm();
    } catch (error) {
      errEl.textContent = 'Could not save product to database.';
      errEl.hidden = false;
      try {
        handleFirestoreError(error, editId ? OperationType.UPDATE : OperationType.CREATE, `products/${editId || 'new'}`);
      } catch {
        // Logged
      }
    } finally {
      saveBtn.disabled = false;
    }
  });

  byId('admin-products-list').addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-admin-action]');
    if (!btn) return;
    if (!isVerifiedOwnerAdmin(state.currentUser)) return;

    const action = btn.getAttribute('data-admin-action');
    const id = btn.getAttribute('data-id');
    if (!id) return;

    if (action === 'toggle-stock') {
      const item = state.products.find((p) => p.id === id);
      if (!item) return;
      try {
        await ensureCatalogInitializedInFirestore();
        await updateDoc(doc(db, 'products', id), {
          inStock: !item.inStock,
          updatedAt: serverTimestamp(),
        });
      } catch (error) {
        try {
          handleFirestoreError(error, OperationType.UPDATE, `products/${id}`);
        } catch {
          // Logged
        }
      }
    } else if (action === 'edit-product') {
      const item = state.products.find((p) => p.id === id);
      if (!item) return;
      byId<HTMLInputElement>('admin-edit-id').value = item.id;
      byId('admin-form-heading').textContent = `Editing: ${item.title}`;
      byId('admin-save-prod-btn').textContent = 'Save Changes';
      byId('admin-cancel-edit-btn').hidden = false;
      byId<HTMLInputElement>('admin-prod-title').value = item.title;
      byId<HTMLInputElement>('admin-prod-price').value = String(item.price);
      byId<HTMLSelectElement>('admin-prod-category').value = item.category;
      byId<HTMLInputElement>('admin-prod-image').value = item.imageUrl || '';
      byId<HTMLTextAreaElement>('admin-prod-desc').value = item.description;
      byId<HTMLInputElement>('admin-prod-instock').checked = Boolean(item.inStock);
      renderAdminColorCheckboxes(item.colors || ['Matte Black']);
      byId<HTMLInputElement>('admin-prod-title').focus();
    } else if (action === 'delete-product') {
      if (state.pendingDeleteProductId === id) {
        state.pendingDeleteProductId = null;
        try {
          await ensureCatalogInitializedInFirestore();
          await deleteDoc(doc(db, 'products', id));
        } catch (error) {
          try {
            handleFirestoreError(error, OperationType.DELETE, `products/${id}`);
          } catch {
            // Logged
          }
        }
      } else {
        state.pendingDeleteProductId = id;
        renderAdminProducts();
      }
    }
  });

  byId('admin-orders-list').addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-admin-action="toggle-order-status"]');
    if (!btn || !isVerifiedOwnerAdmin(state.currentUser)) return;
    const id = btn.getAttribute('data-id');
    if (!id) return;
    const order = state.orders.find((o) => o.id === id);
    if (!order) return;
    const nextStatus = order.status === 'Completed' ? 'Pending' : 'Completed';
    try {
      await updateDoc(doc(db, 'orders', id), {
        status: nextStatus,
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      try {
        handleFirestoreError(error, OperationType.UPDATE, `orders/${id}`);
      } catch {
        // Logged
      }
    }
  });

  byId('admin-clear-orders-btn').addEventListener('click', async (e) => {
    if (!isVerifiedOwnerAdmin(state.currentUser)) return;
    const btn = e.currentTarget as HTMLButtonElement;
    if (!state.confirmClearOrders) {
      state.confirmClearOrders = true;
      btn.textContent = 'Click Again to Clear All';
      return;
    }
    state.confirmClearOrders = false;
    btn.textContent = 'Clear Order Log';
    try {
      const batch = writeBatch(db);
      state.orders.forEach((order) => {
        batch.delete(doc(db, 'orders', order.id));
      });
      await batch.commit();
    } catch (error) {
      try {
        handleFirestoreError(error, OperationType.DELETE, 'orders');
      } catch {
        // Logged
      }
    }
  });

  byId<HTMLFormElement>('admin-settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!isVerifiedOwnerAdmin(state.currentUser)) return;

    const topic =
      byId<HTMLInputElement>('admin-ntfy-topic').value.trim().slice(0, BLUEPRINT_LIMITS.ntfyTopicMaxLength) ||
      DEFAULT_SETTINGS.ntfyTopic;
    const demoUrl = byId<HTMLInputElement>('admin-demo-video').value
      .trim()
      .slice(0, BLUEPRINT_LIMITS.demoVideoUrlMaxLength);

    try {
      await ensureCatalogInitializedInFirestore();
      await setDoc(doc(db, 'settings', 'public'), {
        ntfyTopic: topic,
        demoVideoUrl: demoUrl,
        catalogInitialized: true,
        updatedAt: serverTimestamp(),
      });
      showAdminFeedback(`Saved settings globally (ntfy topic: ${topic}).`);
    } catch (error) {
      showAdminFeedback('Could not save settings to Firestore.', true);
      try {
        handleFirestoreError(error, OperationType.WRITE, 'settings/public');
      } catch {
        // Logged
      }
    }
  });

  byId('admin-test-ntfy-btn').addEventListener('click', async () => {
    const topic = byId<HTMLInputElement>('admin-ntfy-topic').value.trim() || state.settings.ntfyTopic;
    showAdminFeedback(`Sending test alert to ntfy.sh/${topic}...`);

    const ok = await sendNtfyNotification(
      `https://ntfy.sh/${encodeURIComponent(topic)}`,
      { Title: 'Test Alert: 3D Prints Menu', Priority: 'high', Tags: 'package,white_check_mark' },
      'Test notification from 3D Prints Menu admin panel.'
    );
    showAdminFeedback(
      ok
        ? `Test alert delivered to ntfy.sh/${topic}.`
        : `Could not reach ntfy.sh/${topic} from this browser network.`,
      !ok
    );
  });

  byId('admin-reset-defaults-btn').addEventListener('click', async () => {
    if (!isVerifiedOwnerAdmin(state.currentUser)) return;
    try {
      const batch = writeBatch(db);
      state.firestoreProducts.forEach((p) => {
        batch.delete(doc(db, 'products', p.id));
      });
      DEFAULT_PRODUCTS.forEach((product, idx) => {
        batch.set(doc(db, 'products', product.id), {
          id: product.id,
          title: product.title,
          price: product.price,
          category: product.category,
          description: product.description,
          imageUrl: normalizeAssetUrl(product.imageUrl),
          inStock: product.inStock,
          colors: product.colors,
          sortOrder: idx,
          updatedAt: serverTimestamp(),
        });
      });
      batch.set(doc(db, 'settings', 'public'), {
        ntfyTopic: state.settings.ntfyTopic || DEFAULT_SETTINGS.ntfyTopic,
        demoVideoUrl: state.settings.demoVideoUrl || '',
        catalogInitialized: true,
        updatedAt: serverTimestamp(),
      });
      await batch.commit();
      showAdminFeedback('Restored default 6-item catalog globally.');
    } catch (error) {
      showAdminFeedback('Could not reset catalog in Firestore.', true);
      try {
        handleFirestoreError(error, OperationType.WRITE, 'products');
      } catch {
        // Logged
      }
    }
  });
}

function triggerHomeLoadPulse(): void {
  const hash = window.location.hash;
  if (hash.startsWith('#item/') || hash === '#admin') return;
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      document.body.classList.remove('home-pulse-active');
      void document.body.offsetWidth;
      document.body.classList.add('home-pulse-active');
      window.clearTimeout(pulseTimer);
      pulseTimer = window.setTimeout(() => {
        document.body.classList.remove('home-pulse-active');
      }, 3100);
    });
  });
}

function boot(): void {
  syncEffectiveProducts();
  bindEvents();
  renderCatalog(true);
  renderOptionalVideoSection();
  setupScrollReveals();
  triggerHomeLoadPulse();
  startPublicFirestoreSync();

  onAuthStateChanged(auth, (user) => {
    state.currentUser = user;
    updateAdminAuthUI();
    syncAdminOrdersSubscription(user);
    if (isVerifiedOwnerAdmin(user)) {
      void ensureCatalogInitializedInFirestore();
    }
  });

  window.requestAnimationFrame(syncAllLenses);
  window.setTimeout(syncAllLenses, 120);
  if (document.fonts && document.fonts.ready) {
    void document.fonts.ready.then(syncAllLenses);
  }

  handleHashRoute();
}

boot();
