const assert = require("node:assert/strict");
const test = require("node:test");
const skunexus = require("./skunexus.service");
const { _test } = require("./vendorSkuBackfill.service");
const { backfillMissingVendorSkus } = require("./vendorSkuBackfill.service");

function vendorProduct({ id, productId, sku, vendorId }) {
  return {
    id,
    label: "",
    price: 10,
    product_id: productId,
    quantity: 0,
    sku,
    status: 2,
    vendor_id: vendorId
  };
}

test("reuses the only populated vendor SKU assigned to a product", () => {
  const proposals = _test.buildVendorSkuBackfillProposals({
    products: [{ id: "product-1", sku: "VAL-NMU123", state: "Active" }],
    vendorProducts: [
      vendorProduct({
        id: "populated",
        productId: "product-1",
        sku: "NMU123",
        vendorId: "vendor-1"
      }),
      vendorProduct({
        id: "blank",
        productId: "product-1",
        sku: "",
        vendorId: "vendor-2"
      })
    ]
  });

  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].vendorSku, "NMU123");
  assert.equal(proposals[0].method, "reused_product_vendor_sku");
});

test("removes a prefix only when the same vendor has strong evidence", () => {
  const products = [1, 2, 3, 4].map((number) => ({
    id: `product-${number}`,
    sku: `VAL-PART-${number}`,
    state: "Active"
  }));
  const vendorProducts = [1, 2, 3].map((number) =>
    vendorProduct({
      id: `populated-${number}`,
      productId: `product-${number}`,
      sku: `PART-${number}`,
      vendorId: "valair"
    })
  );
  vendorProducts.push(
    vendorProduct({
      id: "blank",
      productId: "product-4",
      sku: "",
      vendorId: "valair"
    })
  );

  const proposals = _test.buildVendorSkuBackfillProposals({
    products,
    vendorProducts
  });

  assert.equal(proposals[0].vendorSku, "PART-4");
  assert.equal(proposals[0].method, "removed_prefix");
});

test("uses the full product SKU when prefix evidence is uncertain", () => {
  const proposals = _test.buildVendorSkuBackfillProposals({
    products: [{ id: "product-1", sku: "BAJA-123", state: "Active" }],
    vendorProducts: [
      vendorProduct({
        id: "blank",
        productId: "product-1",
        sku: "",
        vendorId: "baja"
      })
    ]
  });

  assert.equal(proposals[0].vendorSku, "BAJA-123");
  assert.equal(proposals[0].method, "full_sku_fallback");
});

test("ignores inactive products and assignments that already have a SKU", () => {
  const proposals = _test.buildVendorSkuBackfillProposals({
    products: [
      { id: "active", sku: "ABC-1", state: "Active" },
      { id: "inactive", sku: "ABC-2", state: "Inactive" }
    ],
    vendorProducts: [
      vendorProduct({
        id: "active-filled",
        productId: "active",
        sku: "ABC-1",
        vendorId: "vendor"
      }),
      vendorProduct({
        id: "inactive-blank",
        productId: "inactive",
        sku: "",
        vendorId: "vendor"
      })
    ]
  });

  assert.deepEqual(proposals, []);
});

test("updates SKU Nexus and carries the repaired SKU into the catalog rows", async () => {
  const originalRest = skunexus.rest;
  const calls = [];
  const blankVendorProduct = vendorProduct({
    id: "blank",
    productId: "product-1",
    sku: "",
    vendorId: "vendor"
  });

  skunexus.rest = async (url, options) => {
    calls.push({ options, url });
    return {};
  };

  try {
    const result = await backfillMissingVendorSkus({
      products: [{ id: "product-1", sku: "ABC-123", state: "Active" }],
      vendorProducts: [blankVendorProduct]
    });

    assert.equal(result.updated, 1);
    assert.equal(result.failed, 0);
    assert.equal(blankVendorProduct.sku, "ABC-123");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.body.sku, "ABC-123");
  } finally {
    skunexus.rest = originalRest;
  }
});
