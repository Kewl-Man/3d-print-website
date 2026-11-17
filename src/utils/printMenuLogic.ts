export type PrintCategory = 'Fidgets' | 'Flexi Toys' | 'Desk Gear';
export type ContactMethod = 'Phone' | 'Discord' | 'Email';

export interface PrintProduct {
  id: string;
  title: string;
  price: number;
  category: PrintCategory;
  description: string;
  imageUrl: string;
  inStock: boolean;
  colors: string[];
  sortOrder?: number;
}

export interface PrintOrderInput {
  productId: string;
  productTitle: string;
  unitPrice: number;
  colorName: string;
  quantity: number;
  buyerName: string;
  contactMethod: ContactMethod;
  contact: string;
  notes?: string;
}

export interface PrintOrder extends PrintOrderInput {
  id: string;
  totalPrice: number;
  createdAt: string;
  status: 'Pending' | 'Completed';
  ntfySent: boolean;
}

export type SortOption = 'default' | 'price-asc' | 'price-desc';
export const MAX_ORDER_QUANTITY = 4;

export const BLUEPRINT_LIMITS = {
  idPattern: /^[a-zA-Z0-9_-]+$/,
  idMaxLength: 128,
  titleMaxLength: 120,
  productTitleOrderMaxLength: 140,
  descriptionMaxLength: 1000,
  imageUrlMaxLength: 500,
  colorMaxLength: 40,
  maxColors: 12,
  buyerNameMaxLength: 80,
  contactMaxLength: 140,
  notesMaxLength: 500,
  ntfyTopicMaxLength: 120,
  demoVideoUrlMaxLength: 500,
  maxPrice: 10000,
} as const;

export function normalizeAssetUrl(url: string): string {
  const trimmed = String(url || '').trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('/src/assets/images/')) {
    return `./assets/images/${trimmed.slice('/src/assets/images/'.length)}`;
  }
  if (trimmed.startsWith('/assets/images/')) {
    return `./assets/images/${trimmed.slice('/assets/images/'.length)}`;
  }
  return trimmed.slice(0, BLUEPRINT_LIMITS.imageUrlMaxLength);
}

export function resolveInitialProducts<T>(
  storedProducts: T[] | null,
  defaultProducts: T[],
  catalogInitialized: boolean
): T[] {
  if (catalogInitialized) {
    return Array.isArray(storedProducts) ? storedProducts : [];
  }
  if (Array.isArray(storedProducts) && storedProducts.length > 0) {
    return storedProducts;
  }
  return defaultProducts;
}

export function formatCurrency(amount: number): string {
  const safe = Number.isFinite(amount) ? Math.max(0, amount) : 0;
  return `$${safe.toFixed(2)}`;
}

export function calculateOrderTotal(unitPrice: number, quantity: number): number {
  const safePrice = Number.isFinite(unitPrice) && unitPrice > 0 ? unitPrice : 0;
  const safeQty = Number.isInteger(quantity) && quantity >= 1 ? Math.min(MAX_ORDER_QUANTITY, quantity) : 1;
  return Math.round(safePrice * safeQty * 100) / 100;
}

export function filterProducts(
  products: PrintProduct[],
  category: string,
  query: string,
  sortBy: SortOption = 'default'
): PrintProduct[] {
  const normalizedQuery = query.trim().toLowerCase();
  const filtered = products.filter((item) => {
    const categoryMatch = category === 'All' || item.category === category;
    if (!categoryMatch) return false;
    if (!normalizedQuery) return true;
    return (
      item.title.toLowerCase().includes(normalizedQuery) ||
      item.description.toLowerCase().includes(normalizedQuery) ||
      item.category.toLowerCase().includes(normalizedQuery)
    );
  });
  if (stateSortAsc(sortBy)) {
    return [...filtered].sort((a, b) => a.price - b.price);
  }
  if (sortBy === 'price-desc') {
    return [...filtered].sort((a, b) => b.price - a.price);
  }
  return [...filtered].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
}

function stateSortAsc(sortBy: SortOption): boolean {
  return sortBy === 'price-asc';
}

export function validateOrderInput(input: {
  buyerName: string;
  contactMethod: string;
  contact: string;
  quantity: number;
  productInStock: boolean;
}): { valid: boolean; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  if (!input.productInStock) {
    errors.product = 'This item is currently out of stock.';
  }
  const trimmedName = input.buyerName.trim();
  if (!trimmedName) {
    errors.buyerName = 'Please enter your name.';
  } else if (trimmedName.length > BLUEPRINT_LIMITS.buyerNameMaxLength) {
    errors.buyerName = `Name must be ${BLUEPRINT_LIMITS.buyerNameMaxLength} characters or fewer.`;
  }
  if (!['Phone', 'Discord', 'Email'].includes(input.contactMethod)) {
    errors.contactMethod = 'Select Phone, Discord, or Email.';
  }
  const trimmedContact = input.contact.trim();
  if (!trimmedContact) {
    errors.contact = `Please enter a phone number, Discord, or email.`;
  } else if (trimmedContact.length > BLUEPRINT_LIMITS.contactMaxLength) {
    errors.contact = `Contact info must be ${BLUEPRINT_LIMITS.contactMaxLength} characters or fewer.`;
  } else if (input.contactMethod === 'Email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedContact)) {
    errors.contact = 'Please enter a valid email address.';
  }
  if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > MAX_ORDER_QUANTITY) {
    errors.quantity =
      input.quantity > MAX_ORDER_QUANTITY
        ? 'gng, how much do u need? 🥀'
        : `Quantity must be between 1 and ${MAX_ORDER_QUANTITY}.`;
  }
  return {
    valid: Object.keys(errors).length === 0,
    errors,
  };
}

export function validateProductInput(input: {
  title: string;
  price: number;
  category: string;
  description: string;
  imageUrl?: string;
}): { valid: boolean; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const trimmedTitle = input.title.trim();
  if (!trimmedTitle) {
    errors.title = 'Product title is required.';
  } else if (trimmedTitle.length > BLUEPRINT_LIMITS.titleMaxLength) {
    errors.title = `Title must be ${BLUEPRINT_LIMITS.titleMaxLength} characters or fewer.`;
  }
  if (!Number.isFinite(input.price) || input.price <= 0 || input.price > BLUEPRINT_LIMITS.maxPrice) {
    errors.price = `Price must be between $0.01 and $${BLUEPRINT_LIMITS.maxPrice}.`;
  }
  if (!['Fidgets', 'Flexi Toys', 'Desk Gear'].includes(input.category)) {
    errors.category = 'Choose a valid category.';
  }
  const trimmedDesc = input.description.trim();
  if (!trimmedDesc) {
    errors.description = 'Description is required.';
  } else if (trimmedDesc.length > BLUEPRINT_LIMITS.descriptionMaxLength) {
    errors.description = `Description must be ${BLUEPRINT_LIMITS.descriptionMaxLength} characters or fewer.`;
  }
  if (input.imageUrl && input.imageUrl.trim().length > BLUEPRINT_LIMITS.imageUrlMaxLength) {
    errors.imageUrl = `Image URL must be ${BLUEPRINT_LIMITS.imageUrlMaxLength} characters or fewer.`;
  }
  return {
    valid: Object.keys(errors).length === 0,
    errors,
  };
}

export function buildNtfyPayload(
  order: PrintOrder,
  topic: string
): {
  url: string;
  headers: Record<string, string>;
  body: string;
} {
  const cleanTopic =
    topic
      .trim()
      .replace(/^https?:\/\/ntfy\.sh\//i, '')
      .replace(/^\/+|\/+$/g, '') || 'ziauddin-3dprints-209';
  const lines = [
    `Item: ${order.quantity}x ${order.productTitle}`,
    `Color: ${order.colorName}`,
    `Cash Total: ${formatCurrency(order.totalPrice)} (in person)`,
    `Buyer: ${order.buyerName}`,
    `${order.contactMethod}: ${order.contact}`,
  ];
  if (order.notes && order.notes.trim()) {
    lines.push(`Notes: ${order.notes.trim()}`);
  }
  lines.push(`Order ID: ${order.id}`);

  return {
    url: `https://ntfy.sh/${encodeURIComponent(cleanTopic)}`,
    headers: {
      Title: `New Print Order: ${order.quantity}x ${order.productTitle}`,
      Priority: 'high',
      Tags: 'package',
    },
    body: lines.join('\n'),
  };
}
