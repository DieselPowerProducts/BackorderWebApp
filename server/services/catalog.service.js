const { getSql } = require("../db/neon");
const followUpsService = require("./followUps.service");
const kitQuickShipService = require("./kitQuickShip.service");
const shopifyAvailabilityQueueService = require("./shopifyAvailabilityQueue.service");
const shopifyAvailabilityStateService = require("./shopifyAvailabilityState.service");
const shopifyCollectiveInventoryService = require("./shopifyCollectiveInventory.service");
const skunexus = require("./skunexus.service");
const stockCheckEmailsService = require("./stockCheckEmails.service");
const autoInventoryProductUpdatesService = require("./vendorAutoInventoryProductUpdates.service");
const vendorAutoInventorySettingsService = require("./vendorAutoInventorySettings.service");
const vendorSettingsService = require("./vendorSettings.service");
const vendorSkuBackfillService = require("./vendorSkuBackfill.service");
const {
  buildSkuExceptionKeys,
  getEffectiveSkuExceptions,
  isVendorProductExcepted
} = require("./autoInventorySkuMatcher");

const fullSyncPageSize = 1000;
const productFetchConcurrency = 4;
const stockCheckCacheTtlMs = 5 * 60 * 1000;
const dppWarehouseLabel = "DPP Warehouse";
const dppWarehouseStockType = "WAREHOUSE";
const syncTimezone = process.env.CATALOG_SYNC_TIMEZONE || "America/Los_Angeles";
const warehouseSyncStartHour = 6;
const warehouseSyncEndHour = 20;
const stockCheckSortValues = new Set([
  "all",
  "yesterday",
  "today",
  "tomorrow",
  "no-follow-up"
]);
const productSelectionFields = `
  id
  sku
  name
  state
  qty_available
  is_kit
  relatedProduct {
    sku
    name
    qty
  }
`;

let schemaReady;
let fullSyncPromise = null;
let warehouseSyncPromise = null;
const productRefreshPromises = new Map();
const stockCheckCache = new Map();

function normalizePaging({ page = 1, limit = 50 } = {}) {
  return {
    page: Math.max(Number.parseInt(page, 10) || 1, 1),
    limit: Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 100)
  };
}

function normalizeSearch(search) {
  return String(search || "").trim();
}

function isVendorProductAutoInventoryExcepted(
  vendorProduct,
  settings,
  autoInventoryUpdate
) {
  const effectiveExceptions = getEffectiveSkuExceptions(settings);

  if (effectiveExceptions.length === 0) {
    return false;
  }

  const exceptionKeys = buildSkuExceptionKeys(effectiveExceptions);

  if (exceptionKeys.size === 0) {
    return false;
  }

  return isVendorProductExcepted(vendorProduct, exceptionKeys, [
    autoInventoryUpdate?.sku,
    autoInventoryUpdate?.sheetSku
  ]);
}

function normalizeProductState(state) {
  return String(state || "Active").trim() || "Active";
}

function normalizeStockCheckSort(sort) {
  const normalized = String(sort || "all").trim().toLowerCase();
  return stockCheckSortValues.has(normalized) ? normalized : "all";
}

function normalizeDateText(value) {
  const normalized = String(value || "").trim();

  if (!normalized) {
    return new Date().toISOString().slice(0, 10);
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    const error = new Error("Reference date must use YYYY-MM-DD format.");
    error.statusCode = 400;
    throw error;
  }

  return normalized;
}

function normalizeBoolean(value) {
  return ["1", "true", "yes", "on"].includes(
    String(value || "").trim().toLowerCase()
  );
}

function normalizeRequiredString(value, message) {
  const normalized = String(value || "").trim();

  if (!normalized) {
    const error = new Error(message);
    error.statusCode = 400;
    throw error;
  }

  return normalized;
}

function parseDateText(value) {
  const [year, month, day] = String(value).split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== String(value)
  ) {
    const error = new Error("Reference date is invalid.");
    error.statusCode = 400;
    throw error;
  }

  return date;
}

function formatDateText(date) {
  return date.toISOString().slice(0, 10);
}

function addDaysToDateText(value, days) {
  const date = parseDateText(value);
  date.setUTCDate(date.getUTCDate() + days);
  return formatDateText(date);
}

function emptyProductsResponse() {
  return {
    data: [],
    total: 0,
    totalPages: 0,
    isLastPage: true
  };
}

function paginateRows(rows, { page, limit }) {
  const total = rows.length;
  const totalPages = Math.ceil(total / limit);
  const start = (page - 1) * limit;

  return {
    data: rows.slice(start, start + limit),
    total,
    totalPages,
    isLastPage: totalPages === 0 || page >= totalPages
  };
}

function graphqlString(value) {
  return JSON.stringify(String(value || ""));
}

function graphqlStringList(values) {
  return values.map(graphqlString).join(", ");
}

function normalizeKitChild(row) {
  const sku = String(row?.sku || "").trim();

  if (!sku) {
    return null;
  }

  return {
    sku,
    name: row?.name || sku,
    qty: Math.max(Number(row?.qty || row?.qty_required || 0), 1)
  };
}

function normalizeProductNode(row) {
  const sku = String(row?.sku || "").trim();

  if (!sku) {
    return null;
  }

  return {
    id: row?.id || row?.product_id || "",
    sku,
    name: row?.name || sku,
    state: normalizeProductState(row?.state),
    qty_available: Math.max(
      Number(row?.warehouse_qty_available ?? row?.qty_available ?? 0),
      0
    ),
    is_kit: Boolean(row?.is_kit),
    relatedProduct: (row?.relatedProduct || [])
      .map(normalizeKitChild)
      .filter(Boolean)
  };
}

function getKitChildSkus(products) {
  return Array.from(
    new Set(
      products.flatMap((product) =>
        (product?.relatedProduct || []).map((child) => child.sku).filter(Boolean)
      )
    )
  );
}

function getUnavailableAvailability(hasBuiltToOrderVendor) {
  return hasBuiltToOrderVendor ? "Built to Order" : "Backorder";
}

function mapAvailability(qtyAvailable, hasActiveVendor, hasBuiltToOrderVendor = false) {
  if (Number(qtyAvailable || 0) > 0 || !hasActiveVendor) {
    return "Available";
  }

  return getUnavailableAvailability(hasBuiltToOrderVendor);
}

function mapShopifyAvailabilityToProductAvailability(status) {
  switch (String(status || "")) {
    case "in_stock":
      return "Available";
    case "built_to_order":
      return "Built to Order";
    case "out_of_stock":
    case "backordered":
      return "Backorder";
    default:
      return "";
  }
}

function getProductAvailabilityOverride(
  sku,
  shopifyAvailabilityBySku = new Map(),
  {
    buildToOrderLeadTime = "",
    hasActiveVendor = true,
    hasBuiltToOrderVendor = false,
    qtyAvailable = 0
  } = {}
) {
  const safeSku = String(sku || "").trim();

  if (!safeSku) {
    return "";
  }

  if (Number(qtyAvailable || 0) > 0) {
    return "Available";
  }

  const savedAvailability = shopifyAvailabilityBySku.get(safeSku) || "";
  const availability =
    savedAvailability === "in_stock"
      ? ""
      : mapShopifyAvailabilityToProductAvailability(savedAvailability);

  if (availability === "Backorder" && !hasActiveVendor && !hasBuiltToOrderVendor) {
    return "";
  }

  if (availability) {
    return availability;
  }

  if (String(buildToOrderLeadTime || "").trim()) {
    return "Built to Order";
  }

  return "";
}

function isActiveVendor(vendor) {
  return Number(vendor?.status || 0) >= 2;
}

function getEffectiveQtyAvailable(
  sku,
  productsBySku,
  qtyCache = new Map(),
  visiting = new Set(),
  productVendorAvailability = null
) {
  const safeSku = String(sku || "").trim();

  if (!safeSku) {
    return 0;
  }

  if (qtyCache.has(safeSku)) {
    return qtyCache.get(safeSku);
  }

  const product = productsBySku.get(safeSku);

  if (!product) {
    qtyCache.set(safeSku, 0);
    return 0;
  }

  if (
    product?.id &&
    productVendorAvailability?.collectiveQuantityByProductId?.has(product.id)
  ) {
    const collectiveQuantity = Math.max(
      Number(
        productVendorAvailability.collectiveQuantityByProductId.get(product.id) || 0
      ),
      0
    );

    qtyCache.set(safeSku, collectiveQuantity);
    return collectiveQuantity;
  }

  const isKitWithComponents = Boolean(
    product.is_kit && product.relatedProduct.length > 0
  );
  const vendorQtyAvailable = getVendorQtyAvailable(product, productVendorAvailability);

  if (vendorQtyAvailable > 0 && !isKitWithComponents) {
    qtyCache.set(safeSku, vendorQtyAvailable);
    return vendorQtyAvailable;
  }

  if (!isKitWithComponents) {
    const qtyAvailable = product.is_kit
      ? 0
      : Math.max(product.qty_available, vendorQtyAvailable);
    qtyCache.set(safeSku, qtyAvailable);
    return qtyAvailable;
  }

  if (visiting.has(safeSku)) {
    qtyCache.set(safeSku, 0);
    return 0;
  }

  visiting.add(safeSku);
  const childQtyAvailable = product.relatedProduct.map((child) => {
    const requiredQty = Math.max(Number(child.qty || 0), 1);
    const childQty = getEffectiveQtyAvailable(
      child.sku,
      productsBySku,
      qtyCache,
      visiting,
      productVendorAvailability
    );

    return Math.floor(childQty / requiredQty);
  });
  visiting.delete(safeSku);

  const qtyAvailable =
    childQtyAvailable.length > 0 ? Math.min(...childQtyAvailable) : 0;
  qtyCache.set(safeSku, qtyAvailable);

  return qtyAvailable;
}

function hasActiveVendor(product, productVendorAvailability) {
  return Boolean(
    product?.id &&
      productVendorAvailability?.productIdsWithActiveVendors?.has(product.id)
  );
}

function hasBuiltToOrderVendor(product, productVendorAvailability) {
  return Boolean(
    product?.id &&
      productVendorAvailability?.productIdsWithBuiltToOrderVendors?.has(product.id)
  );
}

function getVendorQtyAvailable(product, productVendorAvailability) {
  if (!product?.id) {
    return 0;
  }

  if (productVendorAvailability?.collectiveQuantityByProductId?.has(product.id)) {
    return Math.max(
      Number(productVendorAvailability.collectiveQuantityByProductId.get(product.id) || 0),
      0
    );
  }

  if (!productVendorAvailability?.vendorQuantityByProductId) {
    return 0;
  }

  return Math.max(
    Number(productVendorAvailability.vendorQuantityByProductId.get(product.id) || 0),
    0
  );
}

function getEffectiveAvailability(
  sku,
  productsBySku,
  productVendorAvailability,
  availabilityCache = new Map(),
  visiting = new Set(),
  shopifyAvailabilityBySku = new Map(),
  buildToOrderLeadTimeBySku = new Map()
) {
  const safeSku = String(sku || "").trim();

  if (!safeSku) {
    return "Backorder";
  }

  if (availabilityCache.has(safeSku)) {
    return availabilityCache.get(safeSku);
  }

  const product = productsBySku.get(safeSku);

  if (!product) {
    availabilityCache.set(safeSku, "Backorder");
    return "Backorder";
  }

  const productHasActiveVendor = hasActiveVendor(product, productVendorAvailability);
  const qtyAvailable = getEffectiveQtyAvailable(
    safeSku,
    productsBySku,
    new Map(),
    new Set(),
    productVendorAvailability
  );
  const isKitWithComponents = Boolean(product.is_kit && product.relatedProduct.length > 0);
  const availabilityOverride = getProductAvailabilityOverride(
    safeSku,
    shopifyAvailabilityBySku,
    {
      hasActiveVendor: productHasActiveVendor,
      hasBuiltToOrderVendor: hasBuiltToOrderVendor(
        product,
        productVendorAvailability
      ),
      buildToOrderLeadTime: buildToOrderLeadTimeBySku.get(safeSku) || "",
      qtyAvailable
    }
  );

  if (availabilityOverride && !isKitWithComponents) {
    availabilityCache.set(safeSku, availabilityOverride);
    return availabilityOverride;
  }

  if (qtyAvailable > 0) {
    availabilityCache.set(safeSku, "Available");
    return "Available";
  }

  if (!isKitWithComponents) {
    const availability = mapAvailability(
      qtyAvailable,
      productHasActiveVendor,
      hasBuiltToOrderVendor(product, productVendorAvailability)
    );

    availabilityCache.set(safeSku, availability);
    return availability;
  }

  if (visiting.has(safeSku)) {
    availabilityCache.set(safeSku, "Backorder");
    return "Backorder";
  }

  visiting.add(safeSku);
  const childAvailabilities = product.relatedProduct.map((child) => {
    const childProduct = productsBySku.get(child.sku);
    const requiredQty = Math.max(Number(child.qty || 0), 1);
    const childQtyAvailable = getEffectiveQtyAvailable(
      child.sku,
      productsBySku,
      new Map(),
      new Set(),
      productVendorAvailability
    );
    const childAvailability = getEffectiveAvailability(
      child.sku,
      productsBySku,
      productVendorAvailability,
      availabilityCache,
      visiting,
      shopifyAvailabilityBySku,
      buildToOrderLeadTimeBySku
    );

    if (childQtyAvailable >= requiredQty) {
      return "Available";
    }

    if (
      childAvailability === "Built to Order" ||
      hasBuiltToOrderVendor(childProduct, productVendorAvailability) ||
      String(buildToOrderLeadTimeBySku.get(child.sku) || "").trim()
    ) {
      return "Built to Order";
    }

    // A component with no inventory source remains informational. Once any
    // stock is known, an insufficient quantity is an actionable shortage.
    if (
      childQtyAvailable <= 0 &&
      !hasActiveVendor(childProduct, productVendorAvailability)
    ) {
      return "Available";
    }

    return "Backorder";
  });
  visiting.delete(safeSku);

  const availability = childAvailabilities.includes("Built to Order")
    ? "Built to Order"
    : availabilityOverride
      ? availabilityOverride
      : childAvailabilities.includes("Backorder")
        ? "Backorder"
        : childAvailabilities.length > 0
          ? "Available"
          : "Backorder";

  availabilityCache.set(safeSku, availability);
  return availability;
}

function matchesProductSearch(product, search) {
  if (!search) {
    return true;
  }

  const terms = String(search)
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const haystack = [product?.sku, product?.name]
    .map((value) => String(value || "").toLowerCase())
    .join(" ");

  return terms.every((term) => haystack.includes(term));
}

function compareStockCheckProducts(left, right) {
  const leftDate = String(left?.followUpDate || "");
  const rightDate = String(right?.followUpDate || "");

  if (leftDate && rightDate && leftDate !== rightDate) {
    return leftDate.localeCompare(rightDate);
  }

  if (leftDate && !rightDate) {
    return -1;
  }

  if (!leftDate && rightDate) {
    return 1;
  }

  return String(left?.sku || "").localeCompare(String(right?.sku || ""), undefined, {
    sensitivity: "base"
  });
}

function filterStockCheckProducts(products, sort, referenceDate) {
  if (sort === "all") {
    return [...products].sort(compareStockCheckProducts);
  }

  if (sort === "no-follow-up") {
    return products
      .filter((product) => !product.followUpDate)
      .sort(compareStockCheckProducts);
  }

  const offsetBySort = {
    yesterday: -1,
    today: 0,
    tomorrow: 1
  };
  const targetDate = addDaysToDateText(referenceDate, offsetBySort[sort] || 0);

  return products
    .filter((product) => product.followUpDate === targetDate)
    .sort(compareStockCheckProducts);
}

function getTimeZoneDateParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    hourCycle: "h23"
  });
  const parts = formatter.formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return {
    localDate: `${byType.year}-${byType.month}-${byType.day}`,
    localHour: Number.parseInt(byType.hour || "0", 10) || 0
  };
}

function flattenProductComponents(products) {
  return products.flatMap((product) =>
    (product?.relatedProduct || [])
      .map(normalizeKitChild)
      .filter(Boolean)
      .map((child) => ({
        parent_product_id: String(product.id || product.product_id || "").trim(),
        child_sku: child.sku,
        child_name: child.name || child.sku,
        qty_required: Math.max(Number(child.qty || 0), 1)
      }))
  );
}

function dedupeRows(rows, keySelector) {
  const rowsByKey = new Map();

  for (const row of rows) {
    const key = String(keySelector(row) || "").trim();

    if (key) {
      rowsByKey.set(key, row);
    }
  }

  return Array.from(rowsByKey.values());
}

function normalizeProductRow(row) {
  return {
    product_id: String(row?.id || row?.product_id || "").trim(),
    sku: String(row?.sku || "").trim(),
    name: String(row?.name || "").trim(),
    state: normalizeProductState(row?.state),
    qty_available: Math.max(Number(row?.qty_available || 0), 0),
    is_kit: Boolean(row?.is_kit),
    relatedProduct: Array.isArray(row?.relatedProduct) ? row.relatedProduct : []
  };
}

function isWarehouseSyncWindow(localHour) {
  return localHour >= warehouseSyncStartHour && localHour < warehouseSyncEndHour;
}

function normalizeVendorRow(row) {
  return {
    vendor_id: String(row?.id || row?.vendor_id || "").trim(),
    name: String(row?.name || "").trim(),
    label: String(row?.label || "").trim(),
    status: Number.parseInt(String(row?.status || 0), 10) || 0
  };
}

function normalizeVendorProductRow(row) {
  return {
    vendor_product_id: String(row?.id || row?.vendor_product_id || "").trim(),
    vendor_id: String(row?.vendor_id || "").trim(),
    product_id: String(row?.product_id || "").trim(),
    sku: String(row?.sku || "").trim(),
    label: String(row?.label || "").trim(),
    quantity: Number(row?.quantity || 0),
    status:
      row?.status === null || row?.status === undefined || row?.status === ""
        ? null
        : Number(row.status),
    price:
      row?.price === null || row?.price === undefined || row?.price === ""
        ? null
        : Number(row.price)
  };
}

function aggregateWarehouseStockRows(rows) {
  const aggregated = new Map();

  for (const row of rows) {
    const productId = String(row?.product?.id || row?.product_id || "").trim();

    if (!productId) {
      continue;
    }

    const existing = aggregated.get(productId) || {
      product_id: productId,
      stock_id: String(row?.id || "").trim(),
      warehouse_label:
        String(row?.location?.warehouse?.label || row?.warehouse_label || "").trim() ||
        dppWarehouseLabel,
      stock_type: String(row?.type || row?.stock_type || "").trim() || dppWarehouseStockType,
      qty: 0,
      qty_available: 0
    };

    existing.qty += Number(row?.qty || 0);
    existing.qty_available += Number(row?.qty_available || 0);

    if (!existing.stock_id) {
      existing.stock_id = String(row?.id || "").trim();
    }

    aggregated.set(productId, existing);
  }

  return Array.from(aggregated.values());
}

async function initializeSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await vendorSettingsService.initializeSchema();
      const sql = getSql();

      await sql`
        CREATE TABLE IF NOT EXISTS catalog_products (
          product_id TEXT PRIMARY KEY,
          sku TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL DEFAULT '',
          state TEXT NOT NULL DEFAULT 'Active',
          qty_available INTEGER NOT NULL DEFAULT 0,
          is_kit BOOLEAN NOT NULL DEFAULT FALSE,
          last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await sql`
        ALTER TABLE catalog_products
        ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'Active'
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS catalog_products_sku_idx
        ON catalog_products (sku)
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS catalog_products_name_idx
        ON catalog_products (name)
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS catalog_products_state_idx
        ON catalog_products (state)
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS catalog_product_components (
          parent_product_id TEXT NOT NULL,
          child_sku TEXT NOT NULL,
          child_name TEXT NOT NULL DEFAULT '',
          qty_required INTEGER NOT NULL DEFAULT 1,
          last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (parent_product_id, child_sku)
        )
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS catalog_product_components_parent_idx
        ON catalog_product_components (parent_product_id)
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS catalog_product_components_child_idx
        ON catalog_product_components (child_sku)
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS catalog_vendors (
          vendor_id TEXT PRIMARY KEY,
          name TEXT NOT NULL DEFAULT '',
          label TEXT NOT NULL DEFAULT '',
          status INTEGER NOT NULL DEFAULT 0,
          last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS catalog_vendors_name_idx
        ON catalog_vendors (name)
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS catalog_vendor_products (
          vendor_product_id TEXT PRIMARY KEY,
          vendor_id TEXT NOT NULL,
          product_id TEXT NOT NULL,
          sku TEXT NOT NULL DEFAULT '',
          label TEXT NOT NULL DEFAULT '',
          quantity DOUBLE PRECISION NOT NULL DEFAULT 0,
          status DOUBLE PRECISION,
          price DOUBLE PRECISION,
          pending_price DOUBLE PRECISION,
          pending_price_source_url TEXT NOT NULL DEFAULT '',
          pending_price_updated_at TIMESTAMPTZ,
          last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await sql`
        ALTER TABLE catalog_vendor_products
        ADD COLUMN IF NOT EXISTS pending_price DOUBLE PRECISION
      `;
      await sql`
        ALTER TABLE catalog_vendor_products
        ADD COLUMN IF NOT EXISTS pending_price_source_url TEXT NOT NULL DEFAULT ''
      `;
      await sql`
        UPDATE catalog_vendor_products
        SET pending_price_source_url = ''
        WHERE pending_price_source_url IS NULL
      `;
      await sql`
        ALTER TABLE catalog_vendor_products
        ALTER COLUMN pending_price_source_url SET DEFAULT ''
      `;
      await sql`
        ALTER TABLE catalog_vendor_products
        ALTER COLUMN pending_price_source_url SET NOT NULL
      `;
      await sql`
        ALTER TABLE catalog_vendor_products
        ADD COLUMN IF NOT EXISTS pending_price_updated_at TIMESTAMPTZ
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS catalog_vendor_products_vendor_idx
        ON catalog_vendor_products (vendor_id)
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS catalog_vendor_products_product_idx
        ON catalog_vendor_products (product_id)
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS catalog_vendor_products_sku_idx
        ON catalog_vendor_products (sku)
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS catalog_vendor_products_pending_price_idx
        ON catalog_vendor_products (pending_price_updated_at DESC)
        WHERE pending_price IS NOT NULL
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS catalog_warehouse_stock (
          product_id TEXT PRIMARY KEY,
          stock_id TEXT NOT NULL DEFAULT '',
          warehouse_label TEXT NOT NULL DEFAULT '',
          stock_type TEXT NOT NULL DEFAULT '',
          qty DOUBLE PRECISION NOT NULL DEFAULT 0,
          qty_available DOUBLE PRECISION NOT NULL DEFAULT 0,
          last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS catalog_sync_state (
          sync_key TEXT PRIMARY KEY,
          sync_value TEXT NOT NULL DEFAULT '',
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
    })();
  }

  return schemaReady;
}

async function getSyncState(key) {
  await initializeSchema();
  const sql = getSql();
  const rows = await sql`
    SELECT sync_value
    FROM catalog_sync_state
    WHERE sync_key = ${key}
  `;

  return String(rows[0]?.sync_value || "");
}

async function setSyncState(key, value) {
  await initializeSchema();
  const sql = getSql();

  await sql`
    INSERT INTO catalog_sync_state (sync_key, sync_value)
    VALUES (${key}, ${String(value || "")})
    ON CONFLICT (sync_key) DO UPDATE
    SET sync_value = EXCLUDED.sync_value,
        updated_at = now()
  `;
}

function buildTermsSearchClause(params, terms, expressions) {
  if (terms.length === 0) {
    return "";
  }

  const index = params.length + 1;
  params.push(JSON.stringify(terms));
  const haystackClause = expressions
    .map((expression) => `lower(coalesce(${expression}, '')) LIKE '%' || lower(term.value) || '%'`)
    .join(" OR ");

  return `
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text($${index}::jsonb) AS term(value)
      WHERE NOT (${haystackClause})
    )
  `;
}

function getSearchTerms(search) {
  return normalizeSearch(search)
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

async function queryProductsPage({ page, limit, search }) {
  const sql = getSql();
  const offset = (page - 1) * limit;
  const terms = getSearchTerms(search);
  const baseParams = [];
  const whereClause = buildTermsSearchClause(baseParams, terms, ["p.sku", "p.name"]);
  const countRows = await sql.query(
    `
      SELECT COUNT(*)::int AS count
      FROM catalog_products p
      WHERE lower(COALESCE(p.state, 'Active')) = 'active'
      ${whereClause}
    `,
    baseParams
  );
  const total = Number(countRows[0]?.count || 0);
  const dataParams = [...baseParams, limit, offset];
  const rows = await sql.query(
    `
      SELECT
        p.product_id AS id,
        p.sku,
        p.name,
        p.state,
        p.qty_available,
        p.is_kit
      FROM catalog_products p
      WHERE lower(COALESCE(p.state, 'Active')) = 'active'
      ${whereClause}
      ORDER BY p.sku ASC
      LIMIT $${dataParams.length - 1}
      OFFSET $${dataParams.length}
    `,
    dataParams
  );

  return {
    data: rows,
    total,
    totalPages: Math.ceil(total / limit),
    isLastPage: total === 0 || page >= Math.ceil(total / limit)
  };
}

async function queryAllVendors() {
  const sql = getSql();
  return sql`
    SELECT vendor_id, name, label, status
    FROM catalog_vendors
    ORDER BY COALESCE(NULLIF(name, ''), label, vendor_id) ASC
  `;
}

async function queryVendorById(vendorId) {
  const sql = getSql();
  const rows = await sql`
    SELECT vendor_id, name, label, status
    FROM catalog_vendors
    WHERE vendor_id = ${vendorId}
    LIMIT 1
  `;

  return rows[0] || null;
}

async function queryVendorProductsPage({ vendorId, page, limit, search }) {
  const sql = getSql();
  const offset = (page - 1) * limit;
  const terms = getSearchTerms(search);
  const baseParams = [vendorId];
  const searchClause = buildTermsSearchClause(baseParams, terms, [
    "vp.sku",
    "vp.label",
    "p.sku",
    "p.name"
  ]);
  const countRows = await sql.query(
    `
      SELECT COUNT(*)::int AS count
      FROM catalog_vendor_products vp
      JOIN catalog_products p
        ON p.product_id = vp.product_id
      WHERE vp.vendor_id = $1
      AND lower(COALESCE(p.state, 'Active')) = 'active'
      ${searchClause}
    `,
    baseParams
  );
  const total = Number(countRows[0]?.count || 0);
  const dataParams = [...baseParams, limit, offset];
  const rows = await sql.query(
    `
      SELECT
        vp.vendor_product_id,
        vp.vendor_id,
        vp.product_id,
        vp.sku,
        vp.label,
        vp.quantity,
        p.sku AS product_sku,
        p.name AS product_name,
        p.qty_available
      FROM catalog_vendor_products vp
      JOIN catalog_products p
        ON p.product_id = vp.product_id
      WHERE vp.vendor_id = $1
      AND lower(COALESCE(p.state, 'Active')) = 'active'
      ${searchClause}
      ORDER BY COALESCE(NULLIF(p.sku, ''), vp.sku, vp.label, vp.vendor_product_id) ASC
      LIMIT $${dataParams.length - 1}
      OFFSET $${dataParams.length}
    `,
    dataParams
  );

  return {
    data: rows,
    total,
    totalPages: Math.ceil(total / limit),
    isLastPage: total === 0 || page >= Math.ceil(total / limit)
  };
}

async function queryProductsBySkus(skus) {
  const uniqueSkus = Array.from(
    new Set((skus || []).map((sku) => String(sku || "").trim()).filter(Boolean))
  );

  if (uniqueSkus.length === 0) {
    return [];
  }

  const sql = getSql();
  const skuJson = JSON.stringify(uniqueSkus);

  return sql.query(
    `
      SELECT
        product_id AS id,
        sku,
        name,
        state,
        qty_available,
        is_kit
      FROM catalog_products
      WHERE sku IN (
        SELECT jsonb_array_elements_text($1::jsonb)
      )
      AND lower(COALESCE(state, 'Active')) = 'active'
    `,
    [skuJson]
  );
}

async function queryExistingProductIds(productIds) {
  const uniqueIds = Array.from(
    new Set((productIds || []).map((value) => String(value || "").trim()).filter(Boolean))
  );

  if (uniqueIds.length === 0) {
    return new Set();
  }

  const sql = getSql();
  const idJson = JSON.stringify(uniqueIds);
  const rows = await sql.query(
    `
      SELECT product_id
      FROM catalog_products
      WHERE product_id IN (
        SELECT jsonb_array_elements_text($1::jsonb)
      )
    `,
    [idJson]
  );

  return new Set(rows.map((row) => String(row?.product_id || "").trim()).filter(Boolean));
}

async function queryProductsByIds(productIds) {
  const uniqueIds = Array.from(
    new Set((productIds || []).map((value) => String(value || "").trim()).filter(Boolean))
  );

  if (uniqueIds.length === 0) {
    return [];
  }

  const sql = getSql();
  const idJson = JSON.stringify(uniqueIds);

  return sql.query(
    `
      SELECT
        product_id AS id,
        sku,
        name,
        state,
        qty_available,
        is_kit
      FROM catalog_products
      WHERE product_id IN (
        SELECT jsonb_array_elements_text($1::jsonb)
      )
      AND lower(COALESCE(state, 'Active')) = 'active'
    `,
    [idJson]
  );
}

async function queryProductBySku(sku) {
  const sql = getSql();
  const rows = await sql`
    SELECT
      product_id AS id,
      sku,
      name,
      state,
      qty_available,
      is_kit
    FROM catalog_products
    WHERE upper(trim(sku)) = upper(trim(${sku}::text))
    AND lower(COALESCE(state, 'Active')) = 'active'
    ORDER BY CASE WHEN sku = ${sku} THEN 0 ELSE 1 END
    LIMIT 1
  `;

  return rows[0] || null;
}

async function queryAllProducts() {
  const sql = getSql();
  return sql`
    SELECT
      product_id AS id,
      sku,
      name,
      state,
      qty_available,
      is_kit
    FROM catalog_products
    WHERE lower(COALESCE(state, 'Active')) = 'active'
    ORDER BY sku ASC
  `;
}

async function queryComponentsByParentIds(productIds) {
  const uniqueIds = Array.from(
    new Set((productIds || []).map((value) => String(value || "").trim()).filter(Boolean))
  );

  if (uniqueIds.length === 0) {
    return [];
  }

  const sql = getSql();
  const idJson = JSON.stringify(uniqueIds);

  return sql.query(
    `
      SELECT
        parent_product_id,
        child_sku,
        child_name,
        qty_required
      FROM catalog_product_components
      WHERE parent_product_id IN (
        SELECT jsonb_array_elements_text($1::jsonb)
      )
    `,
    [idJson]
  );
}

async function queryParentKitsByChildSku(childSku) {
  const sql = getSql();
  return sql`
    SELECT
      p.product_id AS id,
      p.sku,
      p.name,
      p.state,
      p.qty_available,
      p.is_kit,
      c.qty_required
    FROM catalog_product_components c
    JOIN catalog_products p
      ON p.product_id = c.parent_product_id
    WHERE c.child_sku = ${childSku}
    AND p.is_kit = TRUE
    AND lower(COALESCE(p.state, 'Active')) = 'active'
    ORDER BY p.sku ASC
  `;
}

async function queryAllComponents() {
  const sql = getSql();
  return sql`
    SELECT
      parent_product_id,
      child_sku,
      child_name,
      qty_required
    FROM catalog_product_components
  `;
}

async function queryVendorProductsByProductId(productId) {
  const sql = getSql();
  return sql`
    SELECT
      vendor_product_id AS id,
      vendor_id,
      product_id,
      sku,
      label,
      quantity,
      status,
      price,
      pending_price,
      pending_price_source_url,
      pending_price_updated_at
    FROM catalog_vendor_products
    WHERE product_id = ${productId}
    ORDER BY COALESCE(NULLIF(sku, ''), label, vendor_product_id) ASC
  `;
}

async function queryActiveVendorProductsByVendorId(vendorId) {
  const sql = getSql();
  return sql`
    SELECT
      vp.vendor_product_id AS id,
      vp.vendor_id,
      vp.product_id,
      vp.sku,
      vp.label,
      vp.quantity,
      vp.status,
      vp.price,
      vp.pending_price,
      vp.pending_price_source_url,
      vp.pending_price_updated_at,
      p.sku AS product_sku,
      p.name AS product_name
    FROM catalog_vendor_products vp
    JOIN catalog_products p
      ON p.product_id = vp.product_id
    WHERE vp.vendor_id = ${vendorId}
    AND lower(COALESCE(p.state, 'Active')) = 'active'
    ORDER BY COALESCE(NULLIF(p.sku, ''), vp.sku, vp.label, vp.vendor_product_id) ASC
  `;
}

async function queryVendorProductById(vendorProductId) {
  const sql = getSql();
  const rows = await sql`
    SELECT
      vp.vendor_product_id AS id,
      vp.vendor_id,
      vp.product_id,
      vp.sku,
      vp.label,
      vp.quantity,
      vp.status,
      vp.price,
      vp.pending_price,
      vp.pending_price_source_url,
      vp.pending_price_updated_at,
      p.sku AS product_sku,
      p.name AS product_name
    FROM catalog_vendor_products vp
    JOIN catalog_products p
      ON p.product_id = vp.product_id
    WHERE vp.vendor_product_id = ${vendorProductId}
    AND lower(COALESCE(p.state, 'Active')) = 'active'
    LIMIT 1
  `;

  return rows[0] || null;
}

async function queryVendorProductByVendorAndSku(vendorId, sku) {
  const sql = getSql();
  const safeSku = String(sku || "").trim();

  if (!safeSku) {
    return null;
  }

  const rows = await sql`
    SELECT
      vp.vendor_product_id AS id,
      vp.vendor_id,
      vp.product_id,
      vp.sku,
      vp.label,
      vp.quantity,
      vp.status,
      vp.price,
      vp.pending_price,
      vp.pending_price_source_url,
      vp.pending_price_updated_at,
      p.sku AS product_sku,
      p.name AS product_name
    FROM catalog_vendor_products vp
    JOIN catalog_products p
      ON p.product_id = vp.product_id
    WHERE vp.vendor_id = ${vendorId}
    AND lower(COALESCE(p.state, 'Active')) = 'active'
    AND (
      lower(vp.sku) = lower(${safeSku})
      OR lower(vp.label) = lower(${safeSku})
      OR lower(p.sku) = lower(${safeSku})
    )
    ORDER BY
      CASE
        WHEN lower(p.sku) = lower(${safeSku}) THEN 0
        WHEN lower(vp.sku) = lower(${safeSku}) THEN 1
        WHEN lower(vp.label) = lower(${safeSku}) THEN 2
        ELSE 3
      END ASC,
      vp.vendor_product_id ASC
    LIMIT 1
  `;

  return rows[0] || null;
}

async function updateCatalogVendorProductQuantity(vendorProductId, quantity) {
  const sql = getSql();
  const rows = await sql`
    UPDATE catalog_vendor_products
    SET quantity = ${quantity}
    WHERE vendor_product_id = ${vendorProductId}
    RETURNING
      vendor_product_id AS id,
      vendor_id,
      product_id,
      sku,
      label,
      quantity,
      status,
      price
  `;

  return rows[0] || null;
}

async function updateCatalogVendorProductDetails(
  vendorProductId,
  { vendorSku, productCost }
) {
  const sql = getSql();
  const rows = await sql`
    UPDATE catalog_vendor_products
    SET
      sku = ${vendorSku},
      price = ${productCost},
      last_synced_at = now()
    WHERE vendor_product_id = ${vendorProductId}
    RETURNING
      vendor_product_id AS id,
      vendor_id,
      product_id,
      sku,
      label,
      quantity,
      status,
      price
  `;

  return rows[0] || null;
}

async function stageCatalogVendorProductPrice(
  vendorProductId,
  { pendingPrice, sourceUrl }
) {
  await initializeSchema();
  const sql = getSql();
  const rows = await sql`
    UPDATE catalog_vendor_products
    SET
      pending_price = ${pendingPrice},
      pending_price_source_url = ${sourceUrl},
      pending_price_updated_at = now()
    WHERE vendor_product_id = ${vendorProductId}
    RETURNING
      vendor_product_id AS id,
      vendor_id,
      product_id,
      sku,
      price,
      pending_price,
      pending_price_source_url,
      pending_price_updated_at
  `;

  return rows[0] || null;
}

async function queryVendorsByIds(vendorIds) {
  const uniqueIds = Array.from(
    new Set((vendorIds || []).map((value) => String(value || "").trim()).filter(Boolean))
  );

  if (uniqueIds.length === 0) {
    return [];
  }

  const sql = getSql();
  const idJson = JSON.stringify(uniqueIds);

  return sql.query(
    `
      SELECT vendor_id AS id, name, label, status
      FROM catalog_vendors
      WHERE vendor_id IN (
        SELECT jsonb_array_elements_text($1::jsonb)
      )
    `,
    [idJson]
  );
}

async function queryWarehouseStockByProductId(productId) {
  const sql = getSql();
  const rows = await sql`
    SELECT
      product_id,
      stock_id,
      warehouse_label,
      stock_type,
      qty,
      qty_available
    FROM catalog_warehouse_stock
    WHERE product_id = ${productId}
    LIMIT 1
  `;

  return rows[0] || null;
}

async function queryWarehouseStockByProductIds(productIds) {
  const uniqueIds = Array.from(
    new Set((productIds || []).map((value) => String(value || "").trim()).filter(Boolean))
  );

  if (uniqueIds.length === 0) {
    return new Map();
  }

  const sql = getSql();
  const idJson = JSON.stringify(uniqueIds);
  const rows = await sql.query(
    `
      SELECT
        product_id,
        COALESCE(SUM(qty_available), 0) AS qty_available
      FROM catalog_warehouse_stock
      WHERE product_id IN (
        SELECT jsonb_array_elements_text($1::jsonb)
      )
      GROUP BY product_id
    `,
    [idJson]
  );

  return new Map(
    rows.map((row) => [
      String(row?.product_id || "").trim(),
      Math.max(Number(row?.qty_available || 0), 0)
    ])
  );
}

async function attachWarehouseQtyToProducts(products) {
  if (products.length === 0) {
    return [];
  }

  const warehouseQtyByProductId = await queryWarehouseStockByProductIds(
    products.map((product) => product.id || product.product_id).filter(Boolean)
  );

  return products.map((product) => {
    const productId = String(product?.id || product?.product_id || "").trim();

    return {
      ...product,
      warehouse_qty_available: warehouseQtyByProductId.get(productId) || 0
    };
  });
}

async function queryVendorAvailabilityRows(productIds) {
  const sql = getSql();

  if (!productIds) {
    return sql`
      SELECT
        vp.product_id,
        vp.vendor_id,
        vp.quantity,
        v.name AS vendor_name,
        v.status,
        COALESCE(vs.built_to_order, FALSE) AS built_to_order,
        COALESCE(vs.build_time, '') AS build_time
      FROM catalog_vendor_products vp
      JOIN catalog_vendors v
        ON v.vendor_id = vp.vendor_id
      LEFT JOIN vendor_settings vs
        ON vs.vendor_id = vp.vendor_id
    `;
  }

  const uniqueIds = Array.from(
    new Set((productIds || []).map((value) => String(value || "").trim()).filter(Boolean))
  );

  if (uniqueIds.length === 0) {
    return [];
  }

  const idJson = JSON.stringify(uniqueIds);

  return sql.query(
    `
      SELECT
        vp.product_id,
        vp.vendor_id,
        vp.quantity,
        v.name AS vendor_name,
        v.status,
        COALESCE(vs.built_to_order, FALSE) AS built_to_order,
        COALESCE(vs.build_time, '') AS build_time
      FROM catalog_vendor_products vp
      JOIN catalog_vendors v
        ON v.vendor_id = vp.vendor_id
      LEFT JOIN vendor_settings vs
        ON vs.vendor_id = vp.vendor_id
      WHERE vp.product_id IN (
        SELECT jsonb_array_elements_text($1::jsonb)
      )
    `,
    [idJson]
  );
}

function attachComponentsToProducts(products, componentRows) {
  const componentsByProductId = new Map();

  for (const row of componentRows) {
    const parentProductId = String(row?.parent_product_id || "").trim();
    const childSku = String(row?.child_sku || "").trim();

    if (!parentProductId || !childSku) {
      continue;
    }

    const items = componentsByProductId.get(parentProductId) || [];

    items.push({
      sku: childSku,
      name: String(row?.child_name || row?.child_sku || "").trim(),
      qty: Math.max(Number(row?.qty_required || 0), 1)
    });
    componentsByProductId.set(parentProductId, items);
  }

  return products.map((product) => ({
    ...product,
    relatedProduct: componentsByProductId.get(String(product?.id || "").trim()) || []
  }));
}

async function enrichProductsWithComponents(products) {
  if (products.length === 0) {
    return [];
  }

  const componentRows = await queryComponentsByParentIds(
    products.map((product) => product.id).filter(Boolean)
  );

  return attachComponentsToProducts(products, componentRows);
}

async function buildProductGraph(rows) {
  const productsBySku = new Map();
  let nextRows = await attachWarehouseQtyToProducts(
    await enrichProductsWithComponents(rows)
  );

  while (nextRows.length > 0) {
    for (const row of nextRows) {
      const product = normalizeProductNode(row);

      if (product) {
        productsBySku.set(product.sku, product);
      }
    }

    const nextSkus = getKitChildSkus(nextRows).filter((sku) => !productsBySku.has(sku));

    if (nextSkus.length === 0) {
      break;
    }

    const fetchedRows = await queryProductsBySkus(nextSkus);

    if (fetchedRows.length === 0) {
      break;
    }

    nextRows = await attachWarehouseQtyToProducts(
      await enrichProductsWithComponents(fetchedRows)
    );
  }

  return {
    productsBySku,
    qtyCache: new Map(),
    availabilityCache: new Map()
  };
}

async function buildFullProductGraph() {
  const [products, components] = await Promise.all([queryAllProducts(), queryAllComponents()]);
  const productsWithComponents = await attachWarehouseQtyToProducts(
    attachComponentsToProducts(products, components)
  );

  return {
    rows: productsWithComponents,
    graph: {
      productsBySku: new Map(
        productsWithComponents
          .map(normalizeProductNode)
          .filter(Boolean)
          .map((product) => [product.sku, product])
      ),
      qtyCache: new Map(),
      availabilityCache: new Map()
    }
  };
}

function getProductGraphProductIds(productGraph) {
  return Array.from(productGraph?.productsBySku?.values?.() || [])
    .map((product) => String(product?.id || "").trim())
    .filter(Boolean);
}

function getProductGraphSkus(productGraph) {
  return Array.from(productGraph?.productsBySku?.keys?.() || [])
    .map((sku) => String(sku || "").trim())
    .filter(Boolean);
}

function buildProductVendorAvailability(rows, collectiveRows = []) {
  const productIdsWithActiveVendors = new Set();
  const productIdsWithBuiltToOrderVendors = new Set();
  const productIdsWithCollectiveVendors = new Set();
  const builtToOrderBuildTimeByProductId = new Map();
  const collectiveQuantityByProductId = new Map();
  const vendorQuantityByProductId = new Map();

  for (const row of rows) {
    if (!row?.product_id) {
      continue;
    }

    if (
      String(row?.vendor_name || "").trim().toLowerCase() === "dpp collective"
    ) {
      productIdsWithCollectiveVendors.add(row.product_id);
    }

    if (!isActiveVendor(row)) {
      continue;
    }

    productIdsWithActiveVendors.add(row.product_id);

    if (Boolean(row?.built_to_order)) {
      productIdsWithBuiltToOrderVendors.add(row.product_id);
      if (
        !builtToOrderBuildTimeByProductId.has(row.product_id) &&
        String(row?.build_time || "").trim()
      ) {
        builtToOrderBuildTimeByProductId.set(
          row.product_id,
          String(row.build_time).trim()
        );
      }
      continue;
    }

    vendorQuantityByProductId.set(
      row.product_id,
      (vendorQuantityByProductId.get(row.product_id) || 0) +
        Math.max(Number(row.quantity || 0), 0)
    );
  }

  for (const row of collectiveRows) {
    const productId = String(row?.product_id || "").trim();

    if (!productId) {
      continue;
    }

    productIdsWithActiveVendors.add(productId);
    collectiveQuantityByProductId.set(
      productId,
      Math.max(Number(row?.inventory_quantity || 0), 0)
    );
  }

  return {
    builtToOrderBuildTimeByProductId,
    collectiveQuantityByProductId,
    productIdsWithActiveVendors,
    productIdsWithBuiltToOrderVendors,
    productIdsWithCollectiveVendors,
    vendorQuantityByProductId
  };
}

async function getProductVendorAvailabilityInfo(productIds) {
  const [rows, collectiveRows] = await Promise.all([
    queryVendorAvailabilityRows(productIds),
    shopifyCollectiveInventoryService.getStatesForProductIds(productIds)
  ]);

  return buildProductVendorAvailability(rows, collectiveRows);
}

function mapProduct(
  row,
  productVendorAvailability,
  followUpsBySku,
  {
    productsBySku = new Map(),
    qtyCache = new Map(),
    availabilityCache = new Map(),
    shopifyAvailabilityBySku = new Map(),
    buildToOrderLeadTimeBySku = new Map()
  } = {}
) {
  const normalizedRow = normalizeProductNode(row);
  const sku = normalizedRow?.sku || row?.sku || "";
  const product = normalizedRow?.sku
    ? productsBySku.get(normalizedRow.sku) || normalizedRow
    : null;
  const isKit = Boolean(product?.is_kit);
  const hasActiveVendor = productVendorAvailability.productIdsWithActiveVendors.has(row.id);
  const hasBuiltToOrderVendor =
    productVendorAvailability.productIdsWithBuiltToOrderVendors.has(row.id);
  const qtyAvailable = getEffectiveQtyAvailable(
    sku,
    productsBySku,
    qtyCache,
    new Set(),
    productVendorAvailability
  );
  const availability = isKit
    ? getEffectiveAvailability(
        sku,
        productsBySku,
        productVendorAvailability,
        availabilityCache,
        new Set(),
        shopifyAvailabilityBySku,
        buildToOrderLeadTimeBySku
      )
    : getProductAvailabilityOverride(sku, shopifyAvailabilityBySku, {
        buildToOrderLeadTime: buildToOrderLeadTimeBySku.get(sku) || "",
        hasActiveVendor,
        hasBuiltToOrderVendor,
        qtyAvailable
      }) ||
      mapAvailability(qtyAvailable, hasActiveVendor, hasBuiltToOrderVendor);

  return {
    id: row.id,
    sku,
    name: row.name || "",
    qtyAvailable,
    availability,
    hasBuiltToOrderVendor,
    followUpDate: followUpsBySku?.get(sku) || "",
    isKit
  };
}

function formatBuildToOrderMessage(leadTime) {
  const safeLeadTime = String(leadTime || "").trim();

  return safeLeadTime
    ? `This product will ship in ${safeLeadTime} from the manufacturer`
    : "";
}

function getOwnBuildToOrderLeadTime(
  product,
  productVendorAvailability,
  buildToOrderLeadTimeBySku = new Map()
) {
  if (!product?.sku) {
    return "";
  }

  const vendorBuildTime = String(
    productVendorAvailability.builtToOrderBuildTimeByProductId.get(product.id) || ""
  ).trim();
  const storedLeadTime = String(buildToOrderLeadTimeBySku.get(product.sku) || "").trim();

  return vendorBuildTime || storedLeadTime;
}

function getEffectiveBuildToOrderLeadTime(
  sku,
  productGraph,
  productVendorAvailability,
  shopifyAvailabilityBySku = new Map(),
  buildToOrderLeadTimeBySku = new Map(),
  visiting = new Set()
) {
  const safeSku = String(sku || "").trim();

  if (!safeSku || visiting.has(safeSku)) {
    return "";
  }

  const product = productGraph.productsBySku.get(safeSku);

  if (!product) {
    return "";
  }

  const availability = getEffectiveAvailability(
    safeSku,
    productGraph.productsBySku,
    productVendorAvailability,
    productGraph.availabilityCache,
    new Set(),
    shopifyAvailabilityBySku,
    buildToOrderLeadTimeBySku
  );

  if (availability !== "Built to Order") {
    return "";
  }

  const ownLeadTime = getOwnBuildToOrderLeadTime(
    product,
    productVendorAvailability,
    buildToOrderLeadTimeBySku
  );

  if (ownLeadTime) {
    return ownLeadTime;
  }

  if (!product.is_kit || product.relatedProduct.length === 0) {
    return "";
  }

  visiting.add(safeSku);

  for (const child of product.relatedProduct) {
    const childLeadTime = getEffectiveBuildToOrderLeadTime(
      child.sku,
      productGraph,
      productVendorAvailability,
      shopifyAvailabilityBySku,
      buildToOrderLeadTimeBySku,
      visiting
    );

    if (childLeadTime) {
      visiting.delete(safeSku);
      return childLeadTime;
    }
  }

  visiting.delete(safeSku);
  return "";
}

function getLatestBackorderFollowUpDateForKit(
  sku,
  productGraph,
  productVendorAvailability,
  followUpInfoBySku = new Map(),
  shopifyAvailabilityBySku = new Map(),
  buildToOrderLeadTimeBySku = new Map(),
  visiting = new Set()
) {
  const safeSku = String(sku || "").trim();

  if (!safeSku || visiting.has(safeSku)) {
    return "";
  }

  const product = productGraph.productsBySku.get(safeSku);

  if (!product?.is_kit || product.relatedProduct.length === 0) {
    return "";
  }

  visiting.add(safeSku);
  let latestFollowUpDate = "";

  for (const child of product.relatedProduct) {
    const childSku = String(child?.sku || "").trim();

    if (!childSku) {
      continue;
    }

    const childAvailability = getEffectiveAvailability(
      childSku,
      productGraph.productsBySku,
      productVendorAvailability,
      productGraph.availabilityCache,
      new Set(),
      shopifyAvailabilityBySku,
      buildToOrderLeadTimeBySku
    );

    if (childAvailability !== "Backorder") {
      continue;
    }

    const childFollowUpInfo = followUpInfoBySku.get(childSku);

    if (
      childFollowUpInfo?.followUpDate &&
      !childFollowUpInfo.followUpNoEta &&
      childFollowUpInfo.followUpDate > latestFollowUpDate
    ) {
      latestFollowUpDate = childFollowUpInfo.followUpDate;
    }

    const childLatestFollowUpDate = getLatestBackorderFollowUpDateForKit(
      childSku,
      productGraph,
      productVendorAvailability,
      followUpInfoBySku,
      shopifyAvailabilityBySku,
      buildToOrderLeadTimeBySku,
      visiting
    );

    if (childLatestFollowUpDate > latestFollowUpDate) {
      latestFollowUpDate = childLatestFollowUpDate;
    }
  }

  visiting.delete(safeSku);
  return latestFollowUpDate;
}

function mapProductAvailabilityToShopifyStatus(
  product,
  savedAvailabilityStatus,
  availabilityModifier = ""
) {
  if (product.availability === "Available") {
    return "in_stock";
  }

  if (
    availabilityModifier === "built_to_order" ||
    availabilityModifier === "out_of_stock" ||
    availabilityModifier === "discontinued"
  ) {
    return availabilityModifier;
  }

  if (product.availability === "Built to Order") {
    return "built_to_order";
  }

  if (String(savedAvailabilityStatus || "") === "out_of_stock") {
    return "out_of_stock";
  }

  return "backordered";
}

function getShopifyAvailabilityRecord({
  product,
  productGraph,
  productVendorAvailability,
  followUpInfo,
  followUpInfoBySku,
  shopifyAvailabilityModifier,
  shopifyAvailabilityStatus,
  shopifyAvailabilityBySku,
  buildToOrderLeadTimeBySku
}) {
  const availability = mapProductAvailabilityToShopifyStatus(
    product,
    shopifyAvailabilityStatus,
    shopifyAvailabilityModifier
  );
  const buildToOrderLeadTime =
    availability === "built_to_order"
      ? getEffectiveBuildToOrderLeadTime(
          product.sku,
          productGraph,
          productVendorAvailability,
          shopifyAvailabilityBySku,
          buildToOrderLeadTimeBySku
        )
      : undefined;
  const kitBackorderFollowUpDate =
    availability === "backordered"
      ? getLatestBackorderFollowUpDateForKit(
          product.sku,
          productGraph,
          productVendorAvailability,
          followUpInfoBySku,
          shopifyAvailabilityBySku,
          buildToOrderLeadTimeBySku
        )
      : "";
  const followUpDate =
    availability === "backordered" && followUpInfo?.followUpNoEta
      ? ""
      : followUpInfo?.followUpDate || kitBackorderFollowUpDate || "";

  return {
    allowDiscontinuedOverride:
      shopifyAvailabilityModifier === "discontinued",
    sku: product.sku,
    productName: product.name,
    availability,
    buildToOrderLeadTime,
    buildToOrderMessage:
      availability === "built_to_order"
        ? formatBuildToOrderMessage(buildToOrderLeadTime)
        : "",
    followUpDate
  };
}

async function buildShopifyAvailabilityRecords(rows) {
  const productGraph = await buildProductGraph(rows);
  const graphSkus = getProductGraphSkus(productGraph);
  const [
    productVendorAvailability,
    followUpInfoBySku,
    shopifyAvailabilityModifierBySku,
    shopifyAvailabilityBySku,
    buildToOrderLeadTimeBySku
  ] = await Promise.all([
    getProductVendorAvailabilityInfo(getProductGraphProductIds(productGraph)),
    followUpsService.getFollowUpInfoForSkus(graphSkus),
    shopifyAvailabilityStateService.getAvailabilityModifiersForSkus(graphSkus),
    shopifyAvailabilityStateService.getAvailabilityStatusesForSkus(graphSkus),
    shopifyAvailabilityStateService.getBuildToOrderLeadTimesForSkus(graphSkus)
  ]);
  const followUpsBySku = new Map(
    Array.from(followUpInfoBySku.entries()).map(([sku, info]) => [
      sku,
      info.followUpDate
    ])
  );

  return rows.map((row) => {
    const product = mapProduct(row, productVendorAvailability, followUpsBySku, {
      ...productGraph,
      shopifyAvailabilityBySku,
      buildToOrderLeadTimeBySku
    });

    return getShopifyAvailabilityRecord({
      product,
      productGraph,
      productVendorAvailability,
      followUpInfo: followUpInfoBySku.get(product.sku),
      followUpInfoBySku,
      shopifyAvailabilityModifier:
        shopifyAvailabilityModifierBySku.get(product.sku) || "",
      shopifyAvailabilityStatus: shopifyAvailabilityBySku.get(product.sku) || "",
      shopifyAvailabilityBySku,
      buildToOrderLeadTimeBySku
    });
  });
}

async function getShopifyAvailabilityRecordsForSkus(skus) {
  await ensureCatalogReady();
  const rows = await queryProductsBySkus(skus);

  return buildShopifyAvailabilityRecords(rows);
}

async function getAllShopifyAvailabilityRecords() {
  await ensureCatalogReady();
  const rows = await queryAllProducts();

  return buildShopifyAvailabilityRecords(rows);
}

async function syncShopifyAvailabilityForSkus(skus, options = {}) {
  const records = await getShopifyAvailabilityRecordsForSkus(skus);

  if (records.length === 0) {
    return {
      failed: 0,
      matched: 0,
      requested: 0,
      updated: 0,
      unchanged: 0
    };
  }

  const result = await require("./shopify.service").syncVariantAvailabilityMetafields(
    records,
    options
  );
  clearCaches();

  return result;
}

function buildKitChildProducts(
  product,
  productGraph,
  productVendorAvailability,
  shopifyAvailabilityBySku = new Map(),
  buildToOrderLeadTimeBySku = new Map(),
  followUpInfoBySku = new Map()
) {
  if (!product?.is_kit) {
    return [];
  }

  return product.relatedProduct.map((child) => {
    const childProduct = productGraph.productsBySku.get(child.sku);
    const qtyAvailable = getEffectiveQtyAvailable(
      child.sku,
      productGraph.productsBySku,
      productGraph.qtyCache,
      new Set(),
      productVendorAvailability
    );
    const availability = getEffectiveAvailability(
      child.sku,
      productGraph.productsBySku,
      productVendorAvailability,
      productGraph.availabilityCache,
      new Set(),
      shopifyAvailabilityBySku,
      buildToOrderLeadTimeBySku
    );
    const followUpInfo = followUpInfoBySku.get(child.sku);

    return {
      sku: child.sku,
      name: childProduct?.name || child.name || child.sku,
      qtyRequired: Math.max(Number(child.qty || 0), 1),
      qtyAvailable,
      availability,
      builtToOrderLeadTime:
        availability === "Built to Order"
          ? getEffectiveBuildToOrderLeadTime(
              child.sku,
              productGraph,
              productVendorAvailability,
              shopifyAvailabilityBySku,
              buildToOrderLeadTimeBySku
            )
          : "",
      followUpDate:
        availability === "Backorder" && !followUpInfo?.followUpNoEta
          ? followUpInfo?.followUpDate || ""
          : "",
      followUpNoEta: Boolean(followUpInfo?.followUpNoEta),
      isKit: Boolean(childProduct?.is_kit)
    };
  });
}

async function getProductParentKitsForSku(sku) {
  const parentRows = await queryParentKitsByChildSku(sku);

  if (parentRows.length === 0) {
    return [];
  }

  const productGraph = await buildProductGraph(parentRows);
  const graphSkus = getProductGraphSkus(productGraph);
  const [
    productVendorAvailability,
    followUpsBySku,
    shopifyAvailabilityBySku,
    buildToOrderLeadTimeBySku
  ] = await Promise.all([
    getProductVendorAvailabilityInfo(getProductGraphProductIds(productGraph)),
    followUpsService.getFollowUpsForSkus(
      parentRows.map((product) => product.sku).filter(Boolean)
    ),
    shopifyAvailabilityStateService.getAvailabilityStatusesForSkus(graphSkus),
    shopifyAvailabilityStateService.getBuildToOrderLeadTimesForSkus(graphSkus)
  ]);
  const graphWithShopifyAvailability = {
    ...productGraph,
    shopifyAvailabilityBySku,
    buildToOrderLeadTimeBySku
  };

  return parentRows.map((row) => {
    const mappedProduct = mapProduct(
      row,
      productVendorAvailability,
      followUpsBySku,
      graphWithShopifyAvailability
    );

    return {
      sku: mappedProduct.sku,
      name: mappedProduct.name,
      qtyRequired: Math.max(Number(row?.qty_required || 0), 1),
      qtyAvailable: mappedProduct.qtyAvailable,
      availability: mappedProduct.availability,
      followUpDate: mappedProduct.followUpDate
    };
  });
}

async function ensureCatalogReady() {
  return initializeSchema();
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = [];
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker()
  );

  await Promise.all(workers);
  return results;
}

async function fetchAllPages(fetchPage) {
  const firstPage = await fetchPage(1);
  const totalPages = Math.max(Number(firstPage.totalPages || 1), 1);
  const rows = [...(firstPage.rows || [])];

  if (totalPages > 1) {
    const remainingPages = Array.from({ length: totalPages - 1 }, (_, index) => index + 2);
    const remainingResults = await mapWithConcurrency(
      remainingPages,
      productFetchConcurrency,
      (page) => fetchPage(page)
    );

    for (const grid of remainingResults) {
      rows.push(...(grid.rows || []));
    }
  }

  return rows;
}

async function fetchProductsPageFromSkuNexus(page) {
  const data = await skunexus.query(`
    query V1Queries {
      product {
        grid(
          sort: { sku: ASC }
          filter: { state: { operator: eq, value: [${graphqlString("Active")}] } }
          limit: { size: ${fullSyncPageSize}, page: ${page} }
        ) {
          totalSize
          totalPages
          isLastPage
          rows {
            ${productSelectionFields}
          }
        }
      }
    }
  `);

  return data?.product?.grid || {
    rows: [],
    totalSize: 0,
    totalPages: 0,
    isLastPage: true
  };
}

async function fetchActiveProductIdsPageFromSkuNexus(page) {
  const data = await skunexus.query(`
    query V1Queries {
      product {
        grid(
          sort: { sku: ASC }
          filter: { state: { operator: eq, value: [${graphqlString("Active")}] } }
          limit: { size: ${fullSyncPageSize}, page: ${page} }
        ) {
          totalSize
          totalPages
          isLastPage
          rows {
            id
          }
        }
      }
    }
  `);

  return data?.product?.grid || {
    rows: [],
    totalSize: 0,
    totalPages: 0,
    isLastPage: true
  };
}

async function fetchVendorsPageFromSkuNexus(page) {
  const data = await skunexus.query(`
    query V1Queries {
      vendor {
        grid(
          sort: { name: ASC }
          limit: { size: ${fullSyncPageSize}, page: ${page} }
        ) {
          totalSize
          totalPages
          isLastPage
          rows {
            id
            name
            label
            status
          }
        }
      }
    }
  `);

  return data?.vendor?.grid || {
    rows: [],
    totalSize: 0,
    totalPages: 0,
    isLastPage: true
  };
}

async function fetchVendorProductsPageFromSkuNexus(page) {
  const data = await skunexus.query(`
    query V1Queries {
      vendorProduct {
        grid(
          sort: { sku: ASC }
          limit: { size: ${fullSyncPageSize}, page: ${page} }
        ) {
          totalSize
          totalPages
          isLastPage
          rows {
            id
            vendor_id
            product_id
            sku
            label
            quantity
            status
            price
          }
        }
      }
    }
  `);

  return data?.vendorProduct?.grid || {
    rows: [],
    totalSize: 0,
    totalPages: 0,
    isLastPage: true
  };
}

async function fetchWarehouseStockPageFromSkuNexus(page) {
  const data = await skunexus.query(`
    query V1Queries {
      stock {
        stocksGrid(
          filter: {
            type: [${dppWarehouseStockType}]
            location: {
              warehouse_label: { operator: eq, value: [${graphqlString(dppWarehouseLabel)}] }
            }
          }
          limit: { size: ${fullSyncPageSize}, page: ${page} }
        ) {
          totalSize
          totalPages
          isLastPage
          rows {
            id
            qty
            qty_available
            type
            product {
              id
              sku
            }
            location {
              warehouse {
                id
                label
              }
            }
          }
        }
      }
    }
  `);

  return data?.stock?.stocksGrid || {
    rows: [],
    totalSize: 0,
    totalPages: 0,
    isLastPage: true
  };
}

async function fetchProductBySkuFromSkuNexus(sku) {
  const data = await skunexus.query(`
    query V1Queries {
      product {
        grid(
          filter: {
            sku: { operator: eq, value: [${graphqlString(sku)}] }
            state: { operator: eq, value: [${graphqlString("Active")}] }
          }
          limit: { size: 1, page: 1 }
        ) {
          rows {
            ${productSelectionFields}
          }
        }
      }
    }
  `);

  return data?.product?.grid?.rows?.[0] || null;
}

async function fetchProductsBySkusFromSkuNexus(skus) {
  const uniqueSkus = Array.from(
    new Set((skus || []).map((sku) => String(sku || "").trim()).filter(Boolean))
  );

  if (uniqueSkus.length === 0) {
    return [];
  }

  const data = await skunexus.query(`
    query V1Queries {
      product {
        grid(
          filter: {
            sku: { operator: in, value: [${graphqlStringList(uniqueSkus)}] }
            state: { operator: eq, value: [${graphqlString("Active")}] }
          }
          limit: { size: ${uniqueSkus.length}, page: 1 }
        ) {
          rows {
            ${productSelectionFields}
          }
        }
      }
    }
  `);

  return data?.product?.grid?.rows || [];
}

async function fetchProductGraphBySkusFromSkuNexus(skus) {
  const productsBySku = new Map();
  let nextSkus = Array.from(
    new Set((skus || []).map((sku) => String(sku || "").trim()).filter(Boolean))
  );

  while (nextSkus.length > 0) {
    const missingSkus = nextSkus.filter((sku) => !productsBySku.has(sku));

    if (missingSkus.length === 0) {
      break;
    }

    const rows = await fetchProductsBySkusFromSkuNexus(missingSkus);

    if (rows.length === 0) {
      break;
    }

    for (const row of rows) {
      const normalized = normalizeProductRow(row);

      if (normalized.product_id && normalized.sku) {
        productsBySku.set(normalized.sku, normalized);
      }
    }

    nextSkus = getKitChildSkus(Array.from(productsBySku.values()));
  }

  return Array.from(productsBySku.values());
}

async function fetchVendorProductsForSkuFromSkuNexus(sku) {
  const data = await skunexus.query(`
    query V1Queries {
      vendorProduct {
        grid(
          filter: {
            product: { sku: { operator: eq, value: [${graphqlString(sku)}] } }
          }
          limit: { size: ${fullSyncPageSize}, page: 1 }
        ) {
          rows {
            id
            vendor_id
            product_id
            sku
            label
            quantity
            status
            price
          }
        }
      }
    }
  `);

  return data?.vendorProduct?.grid?.rows || [];
}

async function fetchVendorsByIdsFromSkuNexus(vendorIds) {
  const uniqueIds = Array.from(
    new Set((vendorIds || []).map((value) => String(value || "").trim()).filter(Boolean))
  );

  if (uniqueIds.length === 0) {
    return [];
  }

  const data = await skunexus.query(`
    query V1Queries {
      vendor {
        grid(
          filter: { id: { operator: in, value: [${graphqlStringList(uniqueIds)}] } }
          limit: { size: ${uniqueIds.length}, page: 1 }
        ) {
          rows {
            id
            name
            label
            status
          }
        }
      }
    }
  `);

  return data?.vendor?.grid?.rows || [];
}

async function fetchWarehouseStockForSkuFromSkuNexus(sku) {
  const data = await skunexus.query(`
    query V1Queries {
      stock {
        stocksGrid(
          filter: {
            product: { sku: { operator: eq, value: [${graphqlString(sku)}] } }
            type: [${dppWarehouseStockType}]
            location: {
              warehouse_label: { operator: eq, value: [${graphqlString(dppWarehouseLabel)}] }
            }
          }
          limit: { size: 100, page: 1 }
        ) {
          rows {
            id
            qty
            qty_available
            type
            product {
              id
              sku
            }
            location {
              warehouse {
                id
                label
              }
            }
          }
        }
      }
    }
  `);

  return data?.stock?.stocksGrid?.rows || [];
}

async function upsertProducts(rows, syncStamp) {
  const normalizedRows = dedupeRows(
    dedupeRows(
      rows
        .map(normalizeProductRow)
        .filter((row) => row.product_id && row.sku)
        .map(({ product_id, sku, name, state, qty_available, is_kit }) => ({
          product_id,
          sku,
          name,
          state,
          qty_available,
          is_kit
        })),
      (row) => row.product_id
    ),
    (row) => row.sku
  );

  if (normalizedRows.length === 0) {
    return;
  }

  const sql = getSql();
  await deleteProductsDisplacedBySku(normalizedRows);
  await sql.query(
    `
      INSERT INTO catalog_products (
        product_id,
        sku,
        name,
        state,
        qty_available,
        is_kit,
        last_synced_at
      )
      SELECT
        row.product_id,
        row.sku,
        row.name,
        row.state,
        row.qty_available,
        row.is_kit,
        $2::timestamptz
      FROM jsonb_to_recordset($1::jsonb) AS row(
        product_id text,
        sku text,
        name text,
        state text,
        qty_available integer,
        is_kit boolean
      )
      ON CONFLICT (product_id) DO UPDATE
      SET sku = EXCLUDED.sku,
          name = EXCLUDED.name,
          state = EXCLUDED.state,
          qty_available = EXCLUDED.qty_available,
          is_kit = EXCLUDED.is_kit,
          last_synced_at = EXCLUDED.last_synced_at
    `,
    [JSON.stringify(normalizedRows), syncStamp]
  );
}

async function deleteProductsDisplacedBySku(rows) {
  const skuRows = rows
    .map((row) => ({
      product_id: String(row?.product_id || "").trim(),
      sku: String(row?.sku || "").trim()
    }))
    .filter((row) => row.product_id && row.sku);

  if (skuRows.length === 0) {
    return;
  }

  const sql = getSql();
  const displacedRows = await sql.query(
    `
      WITH incoming AS (
        SELECT product_id, sku
        FROM jsonb_to_recordset($1::jsonb) AS row(
          product_id text,
          sku text
        )
      )
      SELECT p.product_id
      FROM catalog_products p
      JOIN incoming i
        ON i.sku = p.sku
      WHERE p.product_id <> i.product_id
    `,
    [JSON.stringify(skuRows)]
  );
  const displacedProductIds = Array.from(
    new Set(
      displacedRows
        .map((row) => String(row?.product_id || "").trim())
        .filter(Boolean)
    )
  );

  if (displacedProductIds.length === 0) {
    return;
  }

  const idJson = JSON.stringify(displacedProductIds);

  await sql.query(
    `
      DELETE FROM catalog_product_components
      WHERE parent_product_id IN (
        SELECT jsonb_array_elements_text($1::jsonb)
      )
    `,
    [idJson]
  );
  await sql.query(
    `
      DELETE FROM catalog_vendor_products
      WHERE product_id IN (
        SELECT jsonb_array_elements_text($1::jsonb)
      )
    `,
    [idJson]
  );
  await sql.query(
    `
      DELETE FROM catalog_warehouse_stock
      WHERE product_id IN (
        SELECT jsonb_array_elements_text($1::jsonb)
      )
    `,
    [idJson]
  );
  await sql.query(
    `
      DELETE FROM catalog_products
      WHERE product_id IN (
        SELECT jsonb_array_elements_text($1::jsonb)
      )
    `,
    [idJson]
  );
}

async function upsertComponents(rows, syncStamp) {
  const rowsByKey = new Map();

  for (const row of rows) {
    const normalizedRow = {
      parent_product_id: String(row?.parent_product_id || "").trim(),
      child_sku: String(row?.child_sku || "").trim(),
      child_name: String(row?.child_name || row?.child_sku || "").trim(),
      qty_required: Math.max(Number(row?.qty_required || 0), 1)
    };

    if (!normalizedRow.parent_product_id || !normalizedRow.child_sku) {
      continue;
    }

    const key = `${normalizedRow.parent_product_id}:${normalizedRow.child_sku}`;
    const current = rowsByKey.get(key);

    rowsByKey.set(key, {
      ...normalizedRow,
      child_name: current?.child_name || normalizedRow.child_name,
      qty_required: (current?.qty_required || 0) + normalizedRow.qty_required
    });
  }

  const normalizedRows = Array.from(rowsByKey.values());

  if (normalizedRows.length === 0) {
    return;
  }

  const sql = getSql();
  await sql.query(
    `
      INSERT INTO catalog_product_components (
        parent_product_id,
        child_sku,
        child_name,
        qty_required,
        last_synced_at
      )
      SELECT
        row.parent_product_id,
        row.child_sku,
        row.child_name,
        row.qty_required,
        $2::timestamptz
      FROM jsonb_to_recordset($1::jsonb) AS row(
        parent_product_id text,
        child_sku text,
        child_name text,
        qty_required integer
      )
      ON CONFLICT (parent_product_id, child_sku) DO UPDATE
      SET child_name = EXCLUDED.child_name,
          qty_required = EXCLUDED.qty_required,
          last_synced_at = EXCLUDED.last_synced_at
    `,
    [JSON.stringify(normalizedRows), syncStamp]
  );
}

async function upsertVendors(rows, syncStamp) {
  const normalizedRows = dedupeRows(
    rows
      .map(normalizeVendorRow)
      .filter((row) => row.vendor_id),
    (row) => row.vendor_id
  );

  if (normalizedRows.length === 0) {
    return;
  }

  const sql = getSql();
  await sql.query(
    `
      INSERT INTO catalog_vendors (
        vendor_id,
        name,
        label,
        status,
        last_synced_at
      )
      SELECT
        row.vendor_id,
        row.name,
        row.label,
        row.status,
        $2::timestamptz
      FROM jsonb_to_recordset($1::jsonb) AS row(
        vendor_id text,
        name text,
        label text,
        status integer
      )
      ON CONFLICT (vendor_id) DO UPDATE
      SET name = EXCLUDED.name,
          label = EXCLUDED.label,
          status = EXCLUDED.status,
          last_synced_at = EXCLUDED.last_synced_at
    `,
    [JSON.stringify(normalizedRows), syncStamp]
  );
}

async function upsertVendorProducts(rows, syncStamp) {
  const normalizedRows = dedupeRows(
    rows
      .map(normalizeVendorProductRow)
      .filter((row) => row.vendor_product_id && row.vendor_id && row.product_id),
    (row) => row.vendor_product_id
  );

  if (normalizedRows.length === 0) {
    return;
  }

  const sql = getSql();
  await sql.query(
    `
      INSERT INTO catalog_vendor_products (
        vendor_product_id,
        vendor_id,
        product_id,
        sku,
        label,
        quantity,
        status,
        price,
        last_synced_at
      )
      SELECT
        row.vendor_product_id,
        row.vendor_id,
        row.product_id,
        row.sku,
        row.label,
        row.quantity,
        row.status,
        row.price,
        $2::timestamptz
      FROM jsonb_to_recordset($1::jsonb) AS row(
        vendor_product_id text,
        vendor_id text,
        product_id text,
        sku text,
        label text,
        quantity double precision,
        status double precision,
        price double precision
      )
      ON CONFLICT (vendor_product_id) DO UPDATE
      SET vendor_id = EXCLUDED.vendor_id,
          product_id = EXCLUDED.product_id,
          sku = EXCLUDED.sku,
          label = EXCLUDED.label,
          quantity = EXCLUDED.quantity,
          status = EXCLUDED.status,
          price = EXCLUDED.price,
          last_synced_at = EXCLUDED.last_synced_at
    `,
    [JSON.stringify(normalizedRows), syncStamp]
  );
}

async function upsertWarehouseStock(rows, syncStamp) {
  const normalizedRows = dedupeRows(
    rows
      .map((row) => ({
        product_id: String(row?.product_id || "").trim(),
        stock_id: String(row?.stock_id || "").trim(),
        warehouse_label: String(row?.warehouse_label || dppWarehouseLabel).trim(),
        stock_type: String(row?.stock_type || dppWarehouseStockType).trim(),
        qty: Number(row?.qty || 0),
        qty_available: Number(row?.qty_available || 0)
      }))
      .filter((row) => row.product_id),
    (row) => row.product_id
  );

  if (normalizedRows.length === 0) {
    return;
  }

  const sql = getSql();
  await sql.query(
    `
      INSERT INTO catalog_warehouse_stock (
        product_id,
        stock_id,
        warehouse_label,
        stock_type,
        qty,
        qty_available,
        last_synced_at
      )
      SELECT
        row.product_id,
        row.stock_id,
        row.warehouse_label,
        row.stock_type,
        row.qty,
        row.qty_available,
        $2::timestamptz
      FROM jsonb_to_recordset($1::jsonb) AS row(
        product_id text,
        stock_id text,
        warehouse_label text,
        stock_type text,
        qty double precision,
        qty_available double precision
      )
      ON CONFLICT (product_id) DO UPDATE
      SET stock_id = EXCLUDED.stock_id,
          warehouse_label = EXCLUDED.warehouse_label,
          stock_type = EXCLUDED.stock_type,
          qty = EXCLUDED.qty,
          qty_available = EXCLUDED.qty_available,
          last_synced_at = EXCLUDED.last_synced_at
    `,
    [JSON.stringify(normalizedRows), syncStamp]
  );
}

async function deleteStaleFullSyncRows(syncStamp, { includeWarehouse = true } = {}) {
  const sql = getSql();

  await sql.query(
    `DELETE FROM catalog_products WHERE last_synced_at < $1::timestamptz`,
    [syncStamp]
  );
  await sql.query(
    `DELETE FROM catalog_product_components WHERE last_synced_at < $1::timestamptz`,
    [syncStamp]
  );
  await sql.query(
    `DELETE FROM catalog_vendors WHERE last_synced_at < $1::timestamptz`,
    [syncStamp]
  );
  await sql.query(
    `DELETE FROM catalog_vendor_products WHERE last_synced_at < $1::timestamptz`,
    [syncStamp]
  );
  if (includeWarehouse) {
    await sql.query(
      `DELETE FROM catalog_warehouse_stock WHERE last_synced_at < $1::timestamptz`,
      [syncStamp]
    );
  }
}

async function deleteStaleWarehouseRows(syncStamp) {
  const sql = getSql();
  await sql.query(
    `DELETE FROM catalog_warehouse_stock WHERE last_synced_at < $1::timestamptz`,
    [syncStamp]
  );
}

async function markProductsInactiveByIds(productIds, syncStamp) {
  const uniqueIds = Array.from(
    new Set((productIds || []).map((value) => String(value || "").trim()).filter(Boolean))
  );

  if (uniqueIds.length === 0) {
    return 0;
  }

  const sql = getSql();
  const rows = await sql.query(
    `
      UPDATE catalog_products
      SET state = 'Inactive',
          qty_available = 0,
          last_synced_at = $2::timestamptz
      WHERE product_id IN (
        SELECT jsonb_array_elements_text($1::jsonb)
      )
      AND lower(COALESCE(state, 'Active')) = 'active'
      RETURNING product_id
    `,
    [JSON.stringify(uniqueIds), syncStamp]
  );

  if (rows.length > 0) {
    await sql.query(
      `
        DELETE FROM catalog_warehouse_stock
        WHERE product_id IN (
          SELECT jsonb_array_elements_text($1::jsonb)
        )
      `,
      [JSON.stringify(rows.map((row) => row.product_id).filter(Boolean))]
    );
  }

  return rows.length;
}

async function markProductInactiveBySku(sku, syncStamp) {
  const safeSku = String(sku || "").trim();

  if (!safeSku) {
    return 0;
  }

  const sql = getSql();
  const rows = await sql`
    UPDATE catalog_products
    SET state = 'Inactive',
        qty_available = 0,
        last_synced_at = ${syncStamp}
    WHERE sku = ${safeSku}
    AND lower(COALESCE(state, 'Active')) = 'active'
    RETURNING product_id
  `;

  if (rows.length > 0) {
    await sql.query(
      `
        DELETE FROM catalog_warehouse_stock
        WHERE product_id IN (
          SELECT jsonb_array_elements_text($1::jsonb)
        )
      `,
      [JSON.stringify(rows.map((row) => row.product_id).filter(Boolean))]
    );
  }

  return rows.length;
}

async function syncInactiveProductStates(syncStamp) {
  const rows = await fetchAllPages(fetchActiveProductIdsPageFromSkuNexus);
  const activeProductIds = new Set(
    rows.map((row) => String(row?.id || "").trim()).filter(Boolean)
  );

  if (activeProductIds.size === 0) {
    throw new Error("SKU Nexus active product state sync returned no products.");
  }

  const sql = getSql();
  const cachedRows = await sql`
    SELECT product_id
    FROM catalog_products
    WHERE lower(COALESCE(state, 'Active')) = 'active'
  `;
  const inactiveProductIds = cachedRows
    .map((row) => String(row?.product_id || "").trim())
    .filter((productId) => productId && !activeProductIds.has(productId));
  const markedInactive = await markProductsInactiveByIds(
    inactiveProductIds,
    syncStamp
  );

  if (markedInactive > 0) {
    clearCaches();
  }

  return {
    activeProducts: activeProductIds.size,
    deactivatedProducts: markedInactive
  };
}

async function syncKitQuickShipAfterWarehouseUpdate(reason) {
  try {
    const result = await kitQuickShipService.syncKitQuickShipMetafields();
    await setSyncState("catalog_last_kit_quick_ship_sync_at", new Date().toISOString());
    await setSyncState("catalog_last_kit_quick_ship_sync_reason", reason);
    await setSyncState("catalog_last_kit_quick_ship_sync_error_at", "");
    await setSyncState("catalog_last_kit_quick_ship_sync_error", "");

    return result;
  } catch (error) {
    const errorMessage = String(
      error?.message || error || "Kit quick ship sync failed."
    ).slice(0, 1000);

    console.error("Kit quick ship sync failed; continuing catalog sync.", error);
    await setSyncState(
      "catalog_last_kit_quick_ship_sync_error_at",
      new Date().toISOString()
    );
    await setSyncState("catalog_last_kit_quick_ship_sync_error", errorMessage);

    return {
      error: errorMessage,
      failed: 0,
      requested: 0,
      updated: 0
    };
  }
}

async function syncShopifyAvailabilityForNewProducts(skus, reason) {
  const uniqueSkus = Array.from(
    new Set((skus || []).map((sku) => String(sku || "").trim()).filter(Boolean))
  );

  if (uniqueSkus.length === 0) {
    return {
      failed: 0,
      matched: 0,
      requested: 0,
      skipped: true,
      updated: 0,
      unchanged: 0
    };
  }

  try {
    const result = await syncShopifyAvailabilityForSkus(uniqueSkus, {
      source: reason
    });
    await setSyncState(
      "catalog_last_new_product_shopify_availability_sync_at",
      new Date().toISOString()
    );
    await setSyncState(
      "catalog_last_new_product_shopify_availability_sync_reason",
      reason
    );
    await setSyncState(
      "catalog_last_new_product_shopify_availability_sync_error_at",
      ""
    );
    await setSyncState(
      "catalog_last_new_product_shopify_availability_sync_error",
      ""
    );

    return result;
  } catch (error) {
    const errorMessage = String(
      error?.message || error || "Shopify availability sync failed."
    ).slice(0, 1000);

    console.error(
      "New product Shopify availability sync failed; continuing catalog sync.",
      error
    );
    await setSyncState(
      "catalog_last_new_product_shopify_availability_sync_error_at",
      new Date().toISOString()
    );
    await setSyncState(
      "catalog_last_new_product_shopify_availability_sync_error",
      errorMessage
    );

    return {
      error: errorMessage,
      failed: uniqueSkus.length,
      matched: 0,
      requested: uniqueSkus.length,
      updated: 0,
      unchanged: 0
    };
  }
}

async function queueShopifyAvailabilityReconciliationAfterFullSync() {
  try {
    return await shopifyAvailabilityQueueService.enqueueNightlyReconciliation();
  } catch (error) {
    const errorMessage = String(
      error?.message || error || "Shopify availability reconciliation could not be queued."
    ).slice(0, 1000);

    console.error(
      "Unable to queue nightly Shopify availability reconciliation.",
      error
    );

    return {
      error: errorMessage,
      queued: 0
    };
  }
}

async function syncShopifyCollectiveInventoryAfterFullSync(reason) {
  try {
    const result = await shopifyCollectiveInventoryService.syncCollectiveInventory({
      reason
    });

    if (Number(result?.vendorProducts?.failed || 0) > 0) {
      throw new Error(
        `${result.vendorProducts.failed} Shopify Collective vendor stock update(s) failed.`
      );
    }

    await setSyncState(
      "catalog_last_shopify_collective_inventory_sync_at",
      result.syncedAt
    );
    await setSyncState(
      "catalog_last_shopify_collective_inventory_sync_reason",
      reason
    );
    await setSyncState("catalog_last_shopify_collective_inventory_sync_error_at", "");
    await setSyncState("catalog_last_shopify_collective_inventory_sync_error", "");

    return result;
  } catch (error) {
    const errorMessage = String(
      error?.message || error || "Shopify Collective inventory sync failed."
    ).slice(0, 1000);

    console.error(
      "Shopify Collective inventory sync failed; continuing catalog sync.",
      error
    );
    await setSyncState(
      "catalog_last_shopify_collective_inventory_sync_error_at",
      new Date().toISOString()
    );
    await setSyncState(
      "catalog_last_shopify_collective_inventory_sync_error",
      errorMessage
    );

    return {
      error: errorMessage,
      failed: true,
      reason
    };
  }
}

async function runFullSync({ reason = "manual" } = {}) {
  await initializeSchema();

  if (fullSyncPromise) {
    return fullSyncPromise;
  }

  fullSyncPromise = (async () => {
    const syncStamp = new Date().toISOString();
    const warehouseRowsResult = fetchAllPages(fetchWarehouseStockPageFromSkuNexus)
      .then((rows) => ({ rows, error: null }))
      .catch((error) => ({ rows: [], error }));
    const [products, vendors, vendorProducts, rawWarehouseRowsResult] =
      await Promise.all([
        fetchAllPages(fetchProductsPageFromSkuNexus),
        fetchAllPages(fetchVendorsPageFromSkuNexus),
        fetchAllPages(fetchVendorProductsPageFromSkuNexus),
        warehouseRowsResult
      ]);
    let warehouseStockRows = [];
    const didSyncWarehouse = !rawWarehouseRowsResult.error;

    if (rawWarehouseRowsResult.error) {
      console.error(
        "Warehouse stock sync failed; continuing without warehouse cache.",
        rawWarehouseRowsResult.error
      );
    } else {
      warehouseStockRows = aggregateWarehouseStockRows(rawWarehouseRowsResult.rows);
    }

    const normalizedProducts = products
      .map(normalizeProductRow)
      .filter((row) => row.product_id && row.sku);
    const existingProductIds = await queryExistingProductIds(
      normalizedProducts.map((row) => row.product_id)
    );
    const newProductSkus = normalizedProducts
      .filter((row) => !existingProductIds.has(row.product_id))
      .map((row) => row.sku)
      .filter(Boolean);
    const componentRows = flattenProductComponents(normalizedProducts);
    const vendorSkuBackfill =
      await vendorSkuBackfillService.backfillMissingVendorSkus({
        products: normalizedProducts,
        vendorProducts
      });

    if (vendorSkuBackfill.failed > 0) {
      console.error("Vendor SKU backfill completed with failures.", {
        failed: vendorSkuBackfill.failed,
        failures: vendorSkuBackfill.failures,
        requested: vendorSkuBackfill.requested
      });
    }

    await upsertProducts(normalizedProducts, syncStamp);
    await upsertComponents(componentRows, syncStamp);
    await upsertVendors(vendors, syncStamp);
    await upsertVendorProducts(vendorProducts, syncStamp);
    if (didSyncWarehouse) {
      await upsertWarehouseStock(warehouseStockRows, syncStamp);
    }
    await deleteStaleFullSyncRows(syncStamp, { includeWarehouse: didSyncWarehouse });
    const kitQuickShip = didSyncWarehouse
      ? await syncKitQuickShipAfterWarehouseUpdate(reason)
      : {
          failed: 0,
          requested: 0,
          skipped: true,
          updated: 0
        };
    const shopifyCollectiveInventory =
      await syncShopifyCollectiveInventoryAfterFullSync(reason);
    const newProductShopifyAvailability =
      await syncShopifyAvailabilityForNewProducts(newProductSkus, reason);
    const shopifyAvailabilityReconciliation =
      await queueShopifyAvailabilityReconciliationAfterFullSync();
    await setSyncState("catalog_last_full_sync_at", syncStamp);
    await setSyncState("catalog_last_full_sync_reason", reason);
    if (didSyncWarehouse) {
      await setSyncState("catalog_last_warehouse_sync_at", syncStamp);
      await setSyncState("catalog_last_warehouse_sync_reason", reason);
    }
    clearCaches();

    return {
      syncedAt: syncStamp,
      products: normalizedProducts.length,
      vendors: vendors.length,
      vendorProducts: vendorProducts.length,
      vendorSkuBackfill,
      warehouseProducts: warehouseStockRows.length,
      kitQuickShip,
      newProductShopifyAvailability,
      shopifyAvailabilityReconciliation,
      shopifyCollectiveInventory
    };
  })();

  try {
    return await fullSyncPromise;
  } finally {
    fullSyncPromise = null;
  }
}

async function runWarehouseSync({ reason = "manual" } = {}) {
  await initializeSchema();

  if (fullSyncPromise) {
    return fullSyncPromise;
  }

  if (warehouseSyncPromise) {
    return warehouseSyncPromise;
  }

  warehouseSyncPromise = (async () => {
    const syncStamp = new Date().toISOString();
    const rawWarehouseRows = await fetchAllPages(fetchWarehouseStockPageFromSkuNexus);
    const warehouseStockRows = aggregateWarehouseStockRows(rawWarehouseRows);
    let productStateResult = {
      activeProducts: 0,
      deactivatedProducts: 0
    };

    await upsertWarehouseStock(warehouseStockRows, syncStamp);
    await deleteStaleWarehouseRows(syncStamp);
    try {
      productStateResult = await syncInactiveProductStates(syncStamp);
      await setSyncState("catalog_last_product_state_sync_at", syncStamp);
      await setSyncState("catalog_last_product_state_sync_reason", reason);
    } catch (error) {
      console.error("Product active-state sync failed; continuing warehouse sync.", error);
    }
    const kitQuickShip = await syncKitQuickShipAfterWarehouseUpdate(reason);
    await setSyncState("catalog_last_warehouse_sync_at", syncStamp);
    await setSyncState("catalog_last_warehouse_sync_reason", reason);
    clearCaches();

    return {
      syncedAt: syncStamp,
      warehouseProducts: warehouseStockRows.length,
      activeProducts: productStateResult.activeProducts,
      deactivatedProducts: productStateResult.deactivatedProducts,
      kitQuickShip
    };
  })();

  try {
    return await warehouseSyncPromise;
  } finally {
    warehouseSyncPromise = null;
  }
}

async function refreshProductBySku(sku, options = {}) {
  const safeSku = normalizeRequiredString(sku, "Product SKU is required.");
  const includeWarehouse = options.includeWarehouse !== false;

  if (fullSyncPromise) {
    await fullSyncPromise;
  }

  const refreshKey = `${safeSku}:${includeWarehouse ? "warehouse" : "product"}`;

  if (productRefreshPromises.has(refreshKey)) {
    return productRefreshPromises.get(refreshKey);
  }

  const refreshPromise = (async () => {
    await initializeSchema();
    const syncStamp = new Date().toISOString();
    const rootProduct = await fetchProductBySkuFromSkuNexus(safeSku);

    if (!rootProduct) {
      await markProductInactiveBySku(safeSku, syncStamp);
      clearCaches();
      const error = new Error("Product not found.");
      error.statusCode = 404;
      throw error;
    }

    const productGraphRows = await fetchProductGraphBySkusFromSkuNexus([safeSku]);
    const normalizedProducts = productGraphRows
      .map(normalizeProductRow)
      .filter((row) => row.product_id && row.sku);
    const componentRows = flattenProductComponents(normalizedProducts);
    const vendorProducts = await fetchVendorProductsForSkuFromSkuNexus(safeSku);
    const vendorIds = Array.from(
      new Set(vendorProducts.map((row) => row.vendor_id).filter(Boolean))
    );
    const vendors = await fetchVendorsByIdsFromSkuNexus(vendorIds);
    let warehouseStockRows = [];
    let didRefreshWarehouse = false;

    if (includeWarehouse) {
      try {
        warehouseStockRows = aggregateWarehouseStockRows(
          await fetchWarehouseStockForSkuFromSkuNexus(safeSku)
        );
        didRefreshWarehouse = true;
      } catch (error) {
        console.error("Product warehouse refresh failed.", error);
      }
    }

    await upsertProducts(normalizedProducts, syncStamp);
    await upsertComponents(componentRows, syncStamp);
    await upsertVendors(vendors, syncStamp);
    await upsertVendorProducts(vendorProducts, syncStamp);
    if (didRefreshWarehouse) {
      await upsertWarehouseStock(warehouseStockRows, syncStamp);
    }

    const sql = getSql();
    const parentProductIds = Array.from(
      new Set(normalizedProducts.map((row) => row.product_id).filter(Boolean))
    );
    const vendorProductProductId =
      normalizedProducts.find((row) => row.sku === safeSku)?.product_id ||
      String(rootProduct?.id || "").trim();

    if (parentProductIds.length > 0) {
      await sql.query(
        `
          DELETE FROM catalog_product_components
          WHERE parent_product_id IN (
            SELECT jsonb_array_elements_text($1::jsonb)
          )
          AND last_synced_at < $2::timestamptz
        `,
        [JSON.stringify(parentProductIds), syncStamp]
      );
    }

    if (vendorProductProductId) {
      await sql.query(
        `
          DELETE FROM catalog_vendor_products
          WHERE product_id = $1
          AND last_synced_at < $2::timestamptz
        `,
        [vendorProductProductId, syncStamp]
      );
      if (didRefreshWarehouse && warehouseStockRows.length === 0) {
        await sql.query(`DELETE FROM catalog_warehouse_stock WHERE product_id = $1`, [
          vendorProductProductId
        ]);
      }
    }

    clearCaches();

    return {
      syncedAt: syncStamp,
      products: normalizedProducts.length,
      vendorProducts: vendorProducts.length
    };
  })();

  productRefreshPromises.set(refreshKey, refreshPromise);

  try {
    return await refreshPromise;
  } finally {
    productRefreshPromises.delete(refreshKey);
  }
}

async function listProducts(queryParams = {}) {
  await ensureCatalogReady();
  const { page, limit } = normalizePaging(queryParams);
  const search = normalizeSearch(queryParams.search);

  if (!search) {
    return emptyProductsResponse();
  }

  const result = await queryProductsPage({ page, limit, search });
  const rows = result.data || [];
  const [productGraph, followUpsBySku] = await Promise.all([
    buildProductGraph(rows),
    followUpsService.getFollowUpsForSkus(rows.map((product) => product.sku).filter(Boolean))
  ]);
  const graphSkus = getProductGraphSkus(productGraph);
  const [
    productVendorAvailability,
    shopifyAvailabilityModifierBySku,
    shopifyAvailabilityBySku,
    buildToOrderLeadTimeBySku
  ] = await Promise.all([
    getProductVendorAvailabilityInfo(getProductGraphProductIds(productGraph)),
    shopifyAvailabilityStateService.getAvailabilityModifiersForSkus(graphSkus),
    shopifyAvailabilityStateService.getAvailabilityStatusesForSkus(graphSkus),
    shopifyAvailabilityStateService.getBuildToOrderLeadTimesForSkus(graphSkus)
  ]);

  return {
    ...result,
    data: rows.map((product) =>
      mapProduct(product, productVendorAvailability, followUpsBySku, {
        ...productGraph,
        shopifyAvailabilityBySku,
        buildToOrderLeadTimeBySku
      })
    )
  };
}

async function getProductDetails(sku) {
  await ensureCatalogReady();
  const safeSku = normalizeRequiredString(sku, "Product SKU is required.");
  const product = await queryProductBySku(safeSku);

  if (!product) {
    const error = new Error("Product not found.");
    error.statusCode = 404;
    throw error;
  }

  const [
    productGraph,
    vendorProducts,
    warehouseStock,
    followUpInfo,
    parentKits
  ] = await Promise.all([
    buildProductGraph([product]),
    queryVendorProductsByProductId(product.id),
    queryWarehouseStockByProductId(product.id),
    followUpsService.getFollowUpInfoForSku(safeSku),
    getProductParentKitsForSku(safeSku)
  ]);
  const productNode =
    productGraph.productsBySku.get(product.sku || safeSku) || normalizeProductNode(product);
  const graphSkus = getProductGraphSkus(productGraph);
  const [
    productVendorAvailability,
    shopifyAvailabilityModifierBySku,
    shopifyAvailabilityBySku,
    buildToOrderLeadTimeBySku,
    childFollowUpInfoBySku
  ] = await Promise.all([
    getProductVendorAvailabilityInfo(getProductGraphProductIds(productGraph)),
    shopifyAvailabilityStateService.getAvailabilityModifiersForSkus(graphSkus),
    shopifyAvailabilityStateService.getAvailabilityStatusesForSkus(graphSkus),
    shopifyAvailabilityStateService.getBuildToOrderLeadTimesForSkus(graphSkus),
    followUpsService.getFollowUpInfoForSkus(graphSkus)
  ]);
  const builtToOrderLeadTime =
    buildToOrderLeadTimeBySku.get(productNode?.sku || product.sku || safeSku) ||
    "";
  const shopifyAvailabilityStatus =
    shopifyAvailabilityBySku.get(productNode?.sku || product.sku || safeSku) || "";
  const shopifyAvailabilityModifier =
    shopifyAvailabilityModifierBySku.get(
      productNode?.sku || product.sku || safeSku
    ) || "";
  const qtyAvailable = productNode
    ? getEffectiveQtyAvailable(
        productNode.sku,
        productGraph.productsBySku,
        productGraph.qtyCache,
        new Set(),
        productVendorAvailability
      )
    : 0;
  const availability = productNode
    ? getEffectiveAvailability(
        productNode.sku,
        productGraph.productsBySku,
        productVendorAvailability,
        productGraph.availabilityCache,
        new Set(),
        shopifyAvailabilityBySku,
        buildToOrderLeadTimeBySku
      )
    : "Backorder";
  const childProducts = buildKitChildProducts(
    productNode,
    productGraph,
    productVendorAvailability,
    shopifyAvailabilityBySku,
    buildToOrderLeadTimeBySku,
    childFollowUpInfoBySku
  );
  const vendorIds = Array.from(
    new Set(vendorProducts.map((row) => row.vendor_id).filter(Boolean))
  );
  const vendorProductIds = vendorProducts
    .map((row) => row.id)
    .filter(Boolean);
  const [
    vendors,
    settingsByVendorId,
    autoInventorySettingsByVendorId,
    autoInventoryUpdatesByVendorProductId
  ] = await Promise.all([
    queryVendorsByIds(vendorIds),
    vendorSettingsService.getVendorSettingsByVendorIds(vendorIds),
    vendorAutoInventorySettingsService.getSettingsByVendorIds(vendorIds),
    autoInventoryProductUpdatesService.getUpdatesForVendorProductIds(
      vendorProductIds
    )
  ]);
  const vendorsById = new Map(vendors.map((vendor) => [vendor.id, vendor]));
  const assignedVendors = vendorProducts
    .filter((vendorProduct) => vendorProduct.id && vendorProduct.vendor_id)
    .map((vendorProduct) => {
      const vendor = vendorsById.get(vendorProduct.vendor_id);
      const settings = settingsByVendorId.get(vendorProduct.vendor_id);
      const autoInventorySettings = autoInventorySettingsByVendorId.get(
        vendorProduct.vendor_id
      );
      const candidateAutoInventoryUpdate =
        autoInventoryUpdatesByVendorProductId.get(vendorProduct.id);
      const isAutoInventoryExcepted = isVendorProductAutoInventoryExcepted(
        vendorProduct,
        autoInventorySettings,
        candidateAutoInventoryUpdate
      );
      const canUseAutoInventoryUpdate = Boolean(
        autoInventorySettings?.enabled &&
          !isAutoInventoryExcepted
      );
      const autoInventoryUpdate = canUseAutoInventoryUpdate
        ? candidateAutoInventoryUpdate
        : null;

      return {
        id: vendorProduct.vendor_id,
        vendorProductId: vendorProduct.id,
        vendorSku: String(vendorProduct.sku || ""),
        productCost:
          vendorProduct.price === null || vendorProduct.price === undefined
            ? null
            : Number(vendorProduct.price),
        newProductCost:
          vendorProduct.pending_price === null || vendorProduct.pending_price === undefined
            ? null
            : Number(vendorProduct.pending_price),
        priceSourceUrl: String(vendorProduct.pending_price_source_url || ""),
        priceReceivedAt: vendorProduct.pending_price_updated_at || null,
        name: vendor?.name || vendor?.label || vendorProduct.vendor_id,
        quantity: Number(vendorProduct.quantity || 0),
        stockSource: "vendor",
        stockType: "VENDOR",
        canUpdateStock: !settings?.builtToOrder,
        builtToOrder: Boolean(settings?.builtToOrder),
        buildTime: String(settings?.buildTime || ""),
        autoInventoryEnabled: Boolean(autoInventorySettings?.enabled),
        autoInventoryExcepted: Boolean(isAutoInventoryExcepted),
        autoInventoryManaged: Boolean(autoInventoryUpdate),
        autoInventoryQuantity: autoInventoryUpdate
          ? Number(autoInventoryUpdate.quantity || 0)
          : null,
        autoInventoryUpdatedAt: autoInventoryUpdate?.updatedAt || "",
        autoInventorySheetSku: autoInventoryUpdate?.sheetSku || "",
        autoInventoryMode: autoInventoryUpdate
          ? autoInventorySettings.inventoryMode
          : ""
      };
    });
  const assignedStockSources = [
    ...assignedVendors,
    ...(warehouseStock
      ? [
          {
            id: warehouseStock.stock_id || dppWarehouseLabel,
            vendorProductId: `warehouse:${warehouseStock.stock_id || dppWarehouseLabel}`,
            vendorSku: "",
            productCost: null,
            newProductCost: null,
            priceSourceUrl: "",
            priceReceivedAt: null,
            name: warehouseStock.warehouse_label || dppWarehouseLabel,
            quantity: Number(warehouseStock.qty_available || 0),
            stockSource: "warehouse",
            stockType: warehouseStock.stock_type || dppWarehouseStockType,
            canUpdateStock: false,
            builtToOrder: false,
            buildTime: ""
          }
        ]
      : [])
  ].sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
  );

  return {
    id: product.id,
    sku: product.sku || safeSku,
    name: product.name || product.sku || safeSku,
    qtyAvailable,
    availability,
    isKit: Boolean(productNode?.is_kit),
    followUpDate: followUpInfo.followUpDate,
    followUpNoEta: followUpInfo.followUpNoEta,
    shopifyAvailabilityStatus,
    shopifyAvailabilityModifier,
    builtToOrderLeadTime,
    childProducts,
    parentKits,
    vendors: assignedStockSources
  };
}

async function getStockCheckProducts({
  search,
  sort = "all",
  referenceDate = "",
  bypassCache = false
} = {}) {
  await ensureCatalogReady();
  const cleanSearch = normalizeSearch(search);
  const cleanSort = normalizeStockCheckSort(sort);
  const cleanReferenceDate = normalizeDateText(referenceDate);
  const cacheKey = `${cleanSearch.toLowerCase()}:${cleanSort}:${cleanReferenceDate}`;
  const cached = stockCheckCache.get(cacheKey);
  const shouldBypassCache = normalizeBoolean(bypassCache);

  if (!shouldBypassCache && cached && Date.now() - cached.createdAt < stockCheckCacheTtlMs) {
    return cached.data;
  }

  const [{ rows, graph }, followUpsBySku] = await Promise.all([
    buildFullProductGraph(),
    followUpsService.getAllFollowUps()
  ]);
  const productVendorAvailability = await getProductVendorAvailabilityInfo(
    getProductGraphProductIds(graph)
  );
  const graphSkus = getProductGraphSkus(graph);
  const [shopifyAvailabilityBySku, buildToOrderLeadTimeBySku] =
    await Promise.all([
      shopifyAvailabilityStateService.getAvailabilityStatusesForSkus(graphSkus),
      shopifyAvailabilityStateService.getBuildToOrderLeadTimesForSkus(graphSkus)
    ]);

  const data = rows
    .filter((product) =>
      shouldIncludeNonCollectiveProductInStockCheck(
        product,
        productVendorAvailability
      )
    )
    .map((product) =>
      mapProduct(product, productVendorAvailability, followUpsBySku, {
        ...graph,
        shopifyAvailabilityBySku,
        buildToOrderLeadTimeBySku
      })
    )
    .filter((product) => !product.isKit)
    .filter(shouldIncludeBuiltToOrderProductInStockCheck)
    .filter(
      (product) =>
        product.availability !== "Available" || Boolean(product.followUpDate)
    )
    .filter((product) => matchesProductSearch(product, cleanSearch));
  const filteredData = filterStockCheckProducts(
    data,
    cleanSort,
    cleanReferenceDate
  );

  stockCheckCache.set(cacheKey, {
    createdAt: Date.now(),
    data: filteredData
  });

  return filteredData;
}

async function ensureBackorderFollowUpForSku(sku, followUpDate = "") {
  const safeSku = normalizeRequiredString(sku, "Product SKU is required.");
  const details = await getProductDetails(safeSku);

  if (
    details.isKit ||
    details.availability !== "Backorder" ||
    details.followUpDate ||
    details.followUpNoEta
  ) {
    return {
      created: false,
      followUpDate: details.followUpDate || "",
      sku: details.sku || safeSku
    };
  }

  const effectiveFollowUpDate =
    normalizeDateText(followUpDate) ||
    getTimeZoneDateParts(new Date(), syncTimezone).localDate;
  const inserted = await followUpsService.setMissingFollowUps([
    {
      sku: details.sku || safeSku,
      followUpDate: effectiveFollowUpDate
    }
  ]);

  if (inserted.length > 0) {
    clearCaches();
  }

  return {
    created: inserted.length > 0,
    followUpDate: inserted[0]?.followUpDate || details.followUpDate || "",
    sku: details.sku || safeSku
  };
}

async function ensureMissingBackorderFollowUps(followUpDate = "") {
  const effectiveFollowUpDate =
    normalizeDateText(followUpDate) ||
    getTimeZoneDateParts(new Date(), syncTimezone).localDate;
  const products = await getStockCheckProducts({
    sort: "no-follow-up",
    bypassCache: true
  });
  const inserted = await followUpsService.setMissingFollowUps(
    products
      .filter((product) => product.availability === "Backorder")
      .map((product) => ({
        sku: product.sku,
        followUpDate: effectiveFollowUpDate
      }))
  );

  if (inserted.length > 0) {
    clearCaches();
  }

  return {
    created: inserted.length,
    followUpDate: effectiveFollowUpDate
  };
}

function shouldIncludeBuiltToOrderProductInStockCheck(product) {
  return (
    product?.availability !== "Built to Order" ||
    !product?.hasBuiltToOrderVendor ||
    Boolean(product?.followUpDate)
  );
}

function shouldIncludeNonCollectiveProductInStockCheck(
  product,
  productVendorAvailability
) {
  return (
    !productVendorAvailability?.collectiveQuantityByProductId?.has(product?.id) &&
    !productVendorAvailability?.productIdsWithCollectiveVendors?.has(product?.id)
  );
}

async function listStockCheckProducts(queryParams = {}) {
  const { page, limit } = normalizePaging(queryParams);
  const products = await getStockCheckProducts({
    search: queryParams.search,
    sort: queryParams.sort,
    referenceDate: queryParams.referenceDate,
    bypassCache: queryParams.bypassCache
  });
  const pageResult = paginateRows(products, { page, limit });
  const emailedSkus = await stockCheckEmailsService.getEmailedSkuSetForSkus(
    pageResult.data.map((product) => product.sku)
  );

  return {
    ...pageResult,
    data: pageResult.data.map((product) => ({
      ...product,
      vendorEmailSent: emailedSkus.has(String(product.sku || "").trim().toUpperCase())
    }))
  };
}

function mapVendorSummary(row) {
  return {
    id: String(row?.vendor_id || "").trim(),
    vendor: String(row?.name || row?.label || row?.vendor_id || "").trim()
  };
}

async function listVendors(queryParams = {}) {
  await ensureCatalogReady();
  const { page, limit } = normalizePaging(queryParams);
  const search = normalizeSearch(queryParams.search).toLowerCase();
  const rows = await queryAllVendors();
  const filtered = rows
    .map(mapVendorSummary)
    .filter((vendor) => vendor.id && vendor.vendor)
    .filter((vendor) =>
      !search ? true : vendor.vendor.toLowerCase().includes(search)
    );

  return paginateRows(filtered, { page, limit });
}

async function getVendorDetails(vendorId) {
  await ensureCatalogReady();
  const safeVendorId = normalizeRequiredString(vendorId, "Vendor ID is required.");
  const [vendor, settings] = await Promise.all([
    queryVendorById(safeVendorId),
    vendorSettingsService.getVendorSettings(safeVendorId)
  ]);

  if (!vendor) {
    const error = new Error("Vendor not found.");
    error.statusCode = 404;
    throw error;
  }

  return {
    id: safeVendorId,
    vendor: vendor.name || vendor.label || safeVendorId,
    builtToOrder: Boolean(settings?.builtToOrder),
    buildTime: String(settings?.buildTime || "")
  };
}

async function listVendorProducts(vendorId, queryParams = {}) {
  await ensureCatalogReady();
  const safeVendorId = normalizeRequiredString(vendorId, "Vendor ID is required.");
  const { page, limit } = normalizePaging(queryParams);
  const search = normalizeSearch(queryParams.search);
  const [vendor, pageResult] = await Promise.all([
    getVendorDetails(safeVendorId),
    queryVendorProductsPage({
      vendorId: safeVendorId,
      page,
      limit,
      search
    })
  ]);
  const productIds = pageResult.data.map((row) => row.product_id).filter(Boolean);
  const productSkus = pageResult.data
    .map((row) => row.product_sku || row.sku || row.label || "")
    .filter(Boolean);
  const [
    vendorAvailabilityInfo,
    shopifyAvailabilityBySku,
    buildToOrderLeadTimeBySku
  ] = await Promise.all([
    getProductVendorAvailabilityInfo(productIds),
    shopifyAvailabilityStateService.getAvailabilityStatusesForSkus(productSkus),
    shopifyAvailabilityStateService.getBuildToOrderLeadTimesForSkus(productSkus)
  ]);
  const builtToOrderProductIds = vendorAvailabilityInfo.productIdsWithBuiltToOrderVendors;

  return {
    ...pageResult,
    vendor,
    data: pageResult.data.map((row) => {
      const qtyAvailable = Number(row.qty_available || 0);

      return {
        id: row.product_id || row.vendor_product_id,
        vendorProductId: row.vendor_product_id,
        sku: row.product_sku || row.sku || row.label || "",
        name: row.product_name || "",
        qtyAvailable,
        availability:
          getProductAvailabilityOverride(
            row.product_sku || row.sku || row.label || "",
            shopifyAvailabilityBySku,
            {
              buildToOrderLeadTime:
                buildToOrderLeadTimeBySku.get(
                  row.product_sku || row.sku || row.label || ""
                ) || "",
              hasBuiltToOrderVendor: builtToOrderProductIds.has(row.product_id),
              qtyAvailable
            }
          ) ||
          mapAvailability(
            qtyAvailable,
            true,
            builtToOrderProductIds.has(row.product_id)
          )
      };
    })
  };
}

async function runScheduledFullSync() {
  const { localDate, localHour } = getTimeZoneDateParts(new Date(), syncTimezone);
  const localHourKey = `${localDate}-${String(localHour).padStart(2, "0")}`;
  const lastLocalDate = await getSyncState("catalog_last_full_sync_local_date");

  if (lastLocalDate === localDate) {
    return {
      ok: true,
      skipped: true,
      mode: "full",
      reason: `Full sync already ran for ${localDate} in ${syncTimezone}.`,
      localDate,
      localHour
    };
  }

  try {
    const result = await runFullSync({ reason: "scheduled-full-sync" });
    const automaticBackorderFollowUps =
      await ensureMissingBackorderFollowUps(localDate);
    await setSyncState("catalog_last_full_sync_local_date", localDate);
    await setSyncState("catalog_last_warehouse_sync_local_hour", localHourKey);
    await setSyncState("catalog_last_full_sync_error_at", "");
    await setSyncState("catalog_last_full_sync_error", "");

    return {
      ok: true,
      skipped: false,
      mode: "full",
      localDate,
      localHour,
      automaticBackorderFollowUps,
      ...result
    };
  } catch (error) {
    const errorMessage = String(error?.message || error || "Full sync failed.").slice(
      0,
      1000
    );
    await setSyncState("catalog_last_full_sync_error_at", new Date().toISOString());
    await setSyncState("catalog_last_full_sync_error", errorMessage);
    throw error;
  }
}

async function runScheduledWarehouseSync() {
  const { localDate, localHour } = getTimeZoneDateParts(new Date(), syncTimezone);
  const localHourKey = `${localDate}-${String(localHour).padStart(2, "0")}`;

  if (!isWarehouseSyncWindow(localHour)) {
    return {
      ok: true,
      skipped: true,
      mode: "warehouse",
      reason: `Warehouse sync is paused from 8pm to 6am in ${syncTimezone}.`,
      localDate,
      localHour
    };
  }

  const lastWarehouseLocalHour = await getSyncState(
    "catalog_last_warehouse_sync_local_hour"
  );

  if (lastWarehouseLocalHour === localHourKey) {
    return {
      ok: true,
      skipped: true,
      mode: "warehouse",
      reason: `Warehouse sync already ran for ${localHourKey} in ${syncTimezone}.`,
      localDate,
      localHour
    };
  }

  const result = await runWarehouseSync({ reason: "scheduled-warehouse-sync" });
  const automaticBackorderFollowUps =
    await ensureMissingBackorderFollowUps(localDate);
  await setSyncState("catalog_last_warehouse_sync_local_hour", localHourKey);

  return {
    ok: true,
    skipped: false,
    mode: "warehouse",
    localDate,
    localHour,
    automaticBackorderFollowUps,
    ...result
  };
}

async function getCatalogSyncStatus() {
  await initializeSchema();
  const sql = getSql();
  const stateRows = await sql`
    SELECT sync_key, sync_value, updated_at
    FROM catalog_sync_state
    ORDER BY sync_key ASC
  `;
  const countRows = await sql`
    SELECT
      (SELECT COUNT(*)::int FROM catalog_products) AS products,
      (SELECT COUNT(*)::int FROM catalog_vendors) AS vendors,
      (SELECT COUNT(*)::int FROM catalog_vendor_products) AS vendor_products,
      (SELECT COUNT(*)::int FROM catalog_warehouse_stock) AS warehouse_products,
      (SELECT MAX(last_synced_at) FROM catalog_products) AS products_last_synced_at,
      (SELECT MAX(last_synced_at) FROM catalog_vendors) AS vendors_last_synced_at,
      (SELECT MAX(last_synced_at) FROM catalog_vendor_products) AS vendor_products_last_synced_at,
      (SELECT MAX(last_synced_at) FROM catalog_warehouse_stock) AS warehouse_last_synced_at
  `;
  const syncState = stateRows.reduce((state, row) => {
    state[row.sync_key] = {
      value: row.sync_value,
      updatedAt: row.updated_at
    };

    return state;
  }, {});

  return {
    timezone: syncTimezone,
    syncState,
    counts: countRows[0] || {}
  };
}

async function runScheduledCatalogSync() {
  return runScheduledWarehouseSync();
}

function clearCaches() {
  stockCheckCache.clear();
}

module.exports = {
  clearCaches,
  ensureBackorderFollowUpForSku,
  ensureMissingBackorderFollowUps,
  getAllShopifyAvailabilityRecords,
  getCatalogProductBySku: queryProductBySku,
  getActiveCatalogVendorProductsByVendorId: queryActiveVendorProductsByVendorId,
  getCatalogVendorProductByVendorAndSku: queryVendorProductByVendorAndSku,
  getCatalogVendorProductById: queryVendorProductById,
  getCatalogSyncStatus,
  getProductDetails,
  getShopifyAvailabilityRecordsForSkus,
  getVendorDetails,
  initializeCatalogSchema: initializeSchema,
  listProducts,
  listStockCheckProducts,
  listVendorProducts,
  listVendors,
  refreshProductBySku,
  runScheduledCatalogSync,
  runScheduledFullSync,
  runScheduledWarehouseSync,
  runFullSync,
  runWarehouseSync,
  stageCatalogVendorProductPrice,
  syncShopifyAvailabilityForSkus,
  updateCatalogVendorProductDetails,
  updateCatalogVendorProductQuantity,
  _test: {
    buildProductVendorAvailability,
    getEffectiveAvailability,
    getEffectiveQtyAvailable,
    mapProductAvailabilityToShopifyStatus,
    shouldIncludeBuiltToOrderProductInStockCheck,
    shouldIncludeNonCollectiveProductInStockCheck
  }
};
