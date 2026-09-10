const skunexus = require("./skunexus.service");

const updateConcurrency = 4;
const minimumPrefixEvidence = 3;
const prefixConfidenceThreshold = 0.6;

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeProduct(row) {
  return {
    id: normalizeText(row?.id || row?.product_id),
    sku: normalizeText(row?.sku),
    state: normalizeText(row?.state || "Active").toLowerCase()
  };
}

function normalizeVendorProduct(row) {
  return {
    id: normalizeText(row?.id || row?.vendor_product_id),
    vendorId: normalizeText(row?.vendor_id),
    productId: normalizeText(row?.product_id),
    sku: normalizeText(row?.sku),
    source: row
  };
}

function getPrefixParts(productSku) {
  const dashIndex = productSku.indexOf("-");

  if (dashIndex < 1 || dashIndex === productSku.length - 1) {
    return null;
  }

  return {
    prefix: productSku.slice(0, dashIndex + 1).toUpperCase(),
    remainder: productSku.slice(dashIndex + 1)
  };
}

function getDistinctValues(values) {
  return Array.from(
    new Map(
      values
        .map(normalizeText)
        .filter(Boolean)
        .map((value) => [value.toUpperCase(), value])
    ).values()
  );
}

function buildVendorSkuBackfillProposals({ products, vendorProducts }) {
  const activeProductsById = new Map(
    (products || [])
      .map(normalizeProduct)
      .filter((product) => product.id && product.sku && product.state === "active")
      .map((product) => [product.id, product])
  );
  const normalizedVendorProducts = (vendorProducts || [])
    .map(normalizeVendorProduct)
    .filter(
      (vendorProduct) =>
        vendorProduct.id &&
        vendorProduct.vendorId &&
        activeProductsById.has(vendorProduct.productId)
    );
  const vendorProductsByProductId = new Map();
  const prefixStats = new Map();

  for (const vendorProduct of normalizedVendorProducts) {
    const productRows =
      vendorProductsByProductId.get(vendorProduct.productId) || [];
    productRows.push(vendorProduct);
    vendorProductsByProductId.set(vendorProduct.productId, productRows);

    if (!vendorProduct.sku) {
      continue;
    }

    const productSku = activeProductsById.get(vendorProduct.productId).sku;
    const prefixParts = getPrefixParts(productSku);

    if (!prefixParts) {
      continue;
    }

    const key = `${vendorProduct.vendorId}\t${prefixParts.prefix}`;
    const stats = prefixStats.get(key) || { full: 0, other: 0, stripped: 0 };

    if (vendorProduct.sku.toUpperCase() === productSku.toUpperCase()) {
      stats.full += 1;
    } else if (
      vendorProduct.sku.toUpperCase() === prefixParts.remainder.toUpperCase()
    ) {
      stats.stripped += 1;
    } else {
      stats.other += 1;
    }

    prefixStats.set(key, stats);
  }

  return normalizedVendorProducts
    .filter((vendorProduct) => !vendorProduct.sku)
    .map((vendorProduct) => {
      const product = activeProductsById.get(vendorProduct.productId);
      const siblingSkus = getDistinctValues(
        (vendorProductsByProductId.get(vendorProduct.productId) || []).map(
          (row) => row.sku
        )
      );

      if (siblingSkus.length === 1) {
        return {
          ...vendorProduct,
          method: "reused_product_vendor_sku",
          productSku: product.sku,
          vendorSku: siblingSkus[0]
        };
      }

      const prefixParts = getPrefixParts(product.sku);

      if (prefixParts) {
        const stats = prefixStats.get(
          `${vendorProduct.vendorId}\t${prefixParts.prefix}`
        ) || { full: 0, other: 0, stripped: 0 };
        const evidence = stats.full + stats.other + stats.stripped;

        if (
          stats.stripped >= minimumPrefixEvidence &&
          stats.stripped / evidence >= prefixConfidenceThreshold
        ) {
          return {
            ...vendorProduct,
            method: "removed_prefix",
            productSku: product.sku,
            vendorSku: prefixParts.remainder
          };
        }
      }

      return {
        ...vendorProduct,
        method:
          siblingSkus.length > 1
            ? "full_sku_conflicting_examples"
            : "full_sku_fallback",
        productSku: product.sku,
        vendorSku: product.sku
      };
    });
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }

  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

async function mapWithConcurrency(items, mapper) {
  const results = [];
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex]);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(updateConcurrency, items.length) },
      () => worker()
    )
  );
  return results;
}

async function backfillMissingVendorSkus({ products, vendorProducts }) {
  const proposals = buildVendorSkuBackfillProposals({ products, vendorProducts });
  const results = await mapWithConcurrency(proposals, async (proposal) => {
    const row = proposal.source;
    const payload = Object.fromEntries(
      Object.entries({
        product_id: proposal.productId,
        sku: proposal.vendorSku,
        label: normalizeText(row?.label) || proposal.vendorSku,
        quantity: optionalNumber(row?.quantity) ?? 0,
        price: optionalNumber(row?.price),
        status: optionalNumber(row?.status)
      }).filter(([, value]) => value !== undefined)
    );

    try {
      await skunexus.rest(
        `/vendors/${encodeURIComponent(
          proposal.vendorId
        )}/products/${encodeURIComponent(proposal.id)}`,
        { method: "PUT", body: payload }
      );
      row.sku = proposal.vendorSku;

      return { ...proposal, ok: true, source: undefined };
    } catch (error) {
      return {
        ...proposal,
        error: String(error?.message || error || "Unknown SKU Nexus error."),
        ok: false,
        source: undefined
      };
    }
  });
  const failures = results.filter((result) => !result.ok);
  const methodCounts = results
    .filter((result) => result.ok)
    .reduce((counts, result) => {
      counts[result.method] = (counts[result.method] || 0) + 1;
      return counts;
    }, {});

  return {
    failed: failures.length,
    failures,
    methodCounts,
    requested: proposals.length,
    updated: results.length - failures.length
  };
}

module.exports = {
  backfillMissingVendorSkus,
  _test: {
    buildVendorSkuBackfillProposals,
    getPrefixParts
  }
};
