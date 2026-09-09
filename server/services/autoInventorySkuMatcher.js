function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeSkuKey(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/&/g, "-")
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function getSkuMatchKeys(value) {
  const keys = new Set();
  const addKey = (keyValue) => {
    const key = normalizeSkuKey(keyValue);

    if (key) {
      keys.add(key);
    }
  };

  const values = [value];
  const colonParts = normalizeText(value)
    .split(/[:\uFF1A]/)
    .map((part) => part.trim())
    .filter(Boolean);

  // ATS sheets prefix the actual SKU with an application/group label, such as
  // "306-10 : 309-914-8380". Keep the full value and expose the final segment.
  if (colonParts.length > 1) {
    values.push(colonParts[colonParts.length - 1]);
  }

  for (const candidateValue of values) {
    const safeValue = normalizeSkuKey(candidateValue);

    addKey(safeValue);

    const parts = safeValue.split("-").filter(Boolean);

    if (parts.length > 1 && /^[a-z]+$/.test(parts[0])) {
      addKey(parts.slice(1).join("-"));
    }
  }

  for (const key of Array.from(keys)) {
    const compactKey = key.replace(/-/g, "");

    // Vendor sheets sometimes add grouping dashes that SKU Nexus omits.
    // Keep short keys unchanged to avoid broad matches such as 100-1 / 10-01.
    if (compactKey.length >= 6) {
      keys.add(compactKey);
    }
  }

  return Array.from(keys);
}

function addSkuMatchKeys(keySet, value) {
  for (const key of getSkuMatchKeys(value)) {
    keySet.add(key);
  }
}

function getVendorProductSkuValues(vendorProduct, extraValues = []) {
  return [
    vendorProduct?.product_sku,
    vendorProduct?.sku,
    vendorProduct?.label,
    ...extraValues
  ].filter(Boolean);
}

function buildSkuExceptionKeys(skuExceptions) {
  const keys = new Set();

  for (const sku of skuExceptions || []) {
    addSkuMatchKeys(keys, sku);
  }

  return keys;
}

function getEffectiveSkuExceptions(settings) {
  return Array.from(
    new Set([
      ...(settings?.skuExceptions || []),
      ...(settings?.missingSheetSkuExceptions || [])
    ])
  );
}

function isVendorProductExcepted(vendorProduct, exceptionKeys, extraValues = []) {
  if (!exceptionKeys || exceptionKeys.size === 0) {
    return false;
  }

  return getVendorProductSkuValues(vendorProduct, extraValues).some((value) =>
    getSkuMatchKeys(value).some((key) => exceptionKeys.has(key))
  );
}

module.exports = {
  addSkuMatchKeys,
  buildSkuExceptionKeys,
  getEffectiveSkuExceptions,
  getSkuMatchKeys,
  getVendorProductSkuValues,
  isVendorProductExcepted,
  normalizeSkuKey
};
