const assert = require("node:assert/strict");
const test = require("node:test");
const { _test } = require("./autoInventory.service");

const alphabeticalSettings = {
  inventoryMode: "alphabetical",
  inStockPhrases: ["In Stock", "Available"],
  outOfStockPhrases: ["Out of Stock", "Call for Availability"],
  subtractiveColumn: ""
};

test("tracks recognized alphabetical in-stock rows", () => {
  const result = _test.parseInventoryResult("Available now", alphabeticalSettings);

  assert.equal(result.quantity, 999999);
  assert.equal(_test.getTrackedSheetQuantity(result, "alphabetical"), 999999);
});

test("tracks recognized alphabetical out-of-stock rows", () => {
  const result = _test.parseInventoryResult(
    "Call for Availability",
    alphabeticalSettings
  );

  assert.equal(result.quantity, 0);
  assert.equal(_test.getTrackedSheetQuantity(result, "alphabetical"), 0);
});

test("keeps numerical sheet quantities unchanged", () => {
  const result = {
    quantity: 999999,
    sheetQuantity: 12
  };

  assert.equal(_test.getTrackedSheetQuantity(result, "numerical"), 12);
});

test("treats blank numerical inventory cells as zero stock", () => {
  const result = _test.parseInventoryResult("", {
    inventoryMode: "numerical",
    subtractiveColumn: ""
  });

  assert.equal(result.quantity, 0);
  assert.equal(result.sheetQuantity, 0);
  assert.equal(_test.getTrackedSheetQuantity(result, "numerical"), 0);
});

test("applies a card mapping without changing vendor identity or exceptions", () => {
  const result = _test.applyAuditMappingToSettings(
    {
      vendorId: "vendor-1",
      senderEmail: "vendor@example.com",
      skuHeader: "Default SKU",
      inventoryHeader: "Default Qty",
      skuExceptions: ["KEEP-MANUAL"],
      missingSheetSkuExceptions: ["MISSING-LATER"]
    },
    {
      mapping: {
        skuHeader: "Card SKU",
        inventoryHeader: "Card Qty",
        subtractiveColumn: "Allocated"
      }
    }
  );

  assert.equal(result.skuHeader, "Card SKU");
  assert.equal(result.inventoryHeader, "Card Qty");
  assert.equal(result.subtractiveColumn, "Allocated");
  assert.equal(result.vendorId, "vendor-1");
  assert.equal(result.senderEmail, "vendor@example.com");
  assert.deepEqual(result.skuExceptions, ["KEEP-MANUAL"]);
  assert.deepEqual(result.missingSheetSkuExceptions, ["MISSING-LATER"]);
});


const servicePath = require.resolve("./autoInventory.service");
const catalogPath = require.resolve("./catalog.service");
const auditsPath = require.resolve("./vendorAutoInventoryAudits.service");
const productsPath = require.resolve("./products.service");
const stagingProductUpdatesPath = require.resolve(
  "./vendorAutoInventoryProductUpdates.service"
);
const settingsPath = require.resolve("./vendorAutoInventorySettings.service");

function restoreModule(modulePath, original) {
  if (original) require.cache[modulePath] = original;
  else delete require.cache[modulePath];
}

async function withStagingHarness(callback, vendorProducts = null) {
  const paths = [
    servicePath,
    catalogPath,
    auditsPath,
    productsPath,
    stagingProductUpdatesPath,
    settingsPath
  ];
  const originals = new Map(paths.map((path) => [path, require.cache[path]]));
  const staged = [];
  let productUpdateCalls = 0;
  const exceptionUpdates = [];
  const missingSheetExceptionUpdates = [];

  require.cache[catalogPath] = {
    id: catalogPath,
    filename: catalogPath,
    loaded: true,
    exports: {
      getActiveCatalogVendorProductsByVendorId: async () => vendorProducts || [
        {
          id: "vendor-product-1",
          vendor_id: "vendor-1",
          product_id: "product-1",
          product_sku: "DPP-100",
          sku: "VENDOR-100",
          label: "VENDOR-100",
          quantity: 0,
          price: 10,
          status: 1
        }
      ]
    }
  };
  require.cache[auditsPath] = {
    id: auditsPath,
    filename: auditsPath,
    loaded: true,
    exports: {
      getAuditByAttachment: async () => null,
      stageAudit: async (summary, rows, missingSkus) => {
        staged.push({ summary, rows, missingSkus });
        return { id: "sheet-1", status: summary.status };
      }
    }
  };
  require.cache[productsPath] = {
    id: productsPath,
    filename: productsPath,
    loaded: true,
    exports: {
      setVendorProductQuantity: async () => {
        productUpdateCalls += 1;
        throw new Error("staging must not update inventory");
      }
    }
  };
  require.cache[stagingProductUpdatesPath] = {
    id: stagingProductUpdatesPath,
    filename: stagingProductUpdatesPath,
    loaded: true,
    exports: {
      getUpdatesForVendorProductIds: async () =>
        new Map([
          ["vendor-product-1", { quantity: 7 }]
        ])
    }
  };
  require.cache[settingsPath] = {
    id: settingsPath,
    filename: settingsPath,
    loaded: true,
    exports: {
      setSkuException: async (...args) => exceptionUpdates.push(args),
      setMissingSheetSkuException: async (...args) =>
        missingSheetExceptionUpdates.push(args)
    }
  };
  delete require.cache[servicePath];

  try {
    const service = require(servicePath);
    await callback({
      productUpdateCalls: () => productUpdateCalls,
      exceptionUpdates,
      missingSheetExceptionUpdates,
      staged,
      stageSheetAttachment: service._test.stageSheetAttachment
    });
  } finally {
    for (const path of paths) restoreModule(path, originals.get(path));
  }
}

const stagingSettings = {
  vendorId: "vendor-1",
  senderEmail: "vendor@example.com",
  skuHeader: "Item",
  inventoryHeader: "Available",
  subtractiveColumn: "",
  skuExceptions: [],
  missingSheetSkuExceptions: [],
  inventoryMode: "numerical",
  inStockPhrases: [],
  outOfStockPhrases: []
};

test("stages clean inventory sheets for automatic application", async () => {
  await withStagingHarness(async ({ productUpdateCalls, staged, stageSheetAttachment }) => {
    const result = await stageSheetAttachment({
      settings: stagingSettings,
      attachment: {
        filename: "inventory.csv",
        contentType: "text/csv",
        content: Buffer.from("Item,Available\nVENDOR-100,12\nUNKNOWN,3\n")
      },
      message: {
        uid: "gmail-1",
        messageId: "message-1",
        subject: "Inventory"
      }
    });

    assert.equal(productUpdateCalls(), 0);
    assert.equal(result.staged, 1);
    assert.equal(staged.length, 1);
    assert.equal(staged[0].summary.status, "approved");
    assert.equal(result.autoApply, true);
    assert.equal(staged[0].summary.unmatchedRows, 1);
    assert.deepEqual(staged[0].summary.previewRows, [
      ["VENDOR-100", "12"],
      ["UNKNOWN", "3"]
    ]);
    assert.equal(staged[0].rows[0].changeRequired, true);
    assert.equal(staged[0].rows[0].previousSheetQuantity, 7);
    assert.equal(staged[0].rows[0].proposedQuantity, 999999);
  });
});

test("stages a blank numerical inventory cell as out of stock", async () => {
  await withStagingHarness(async ({ staged, stageSheetAttachment }) => {
    await stageSheetAttachment({
      settings: stagingSettings,
      attachment: {
        filename: "inventory.csv",
        contentType: "text/csv",
        content: Buffer.from("Item,Available\nVENDOR-100,\n")
      },
      message: {
        uid: "gmail-blank",
        messageId: "message-blank",
        subject: "Inventory"
      }
    });

    assert.equal(staged[0].summary.invalidRows, 0);
    assert.equal(staged[0].summary.status, "approved");
    assert.equal(staged[0].rows[0].inventoryValue, "");
    assert.equal(staged[0].rows[0].sheetQuantity, 0);
    assert.equal(staged[0].rows[0].proposedQuantity, 0);
  });
});

test("matches one vendor sheet SKU to every assigned product using that SKU", async () => {
  const vendorProducts = [
    {
      id: "vendor-product-prefixed",
      vendor_id: "vendor-1",
      product_id: "product-prefixed",
      product_sku: "MISH-MMHOSE-RAM-98DBK",
      sku: "MISH-MMHOSE-RAM-98DBK",
      label: "MISH-MMHOSE-RAM-98DBK",
      quantity: 0,
      status: 1
    },
    {
      id: "vendor-product-direct",
      vendor_id: "vendor-1",
      product_id: "product-direct",
      product_sku: "MMHOSE-RAM-98DBK",
      sku: "MMHOSE-RAM-98DBK",
      label: "MMHOSE-RAM-98DBK",
      quantity: 0,
      status: 1
    }
  ];

  await withStagingHarness(async ({ staged, stageSheetAttachment }) => {
    const result = await stageSheetAttachment({
      settings: stagingSettings,
      attachment: {
        filename: "Mishimoto_US_Inventory.csv",
        contentType: "text/csv",
        content: Buffer.from("Item,Available\nMMHOSE-RAM-98DBK,25\n")
      },
      message: { uid: "gmail-mish", messageId: "message-mish" }
    });

    assert.equal(result.staged, 2);
    assert.equal(staged[0].summary.missingSkuRows, 0);
    assert.deepEqual(
      staged[0].rows.map((row) => row.productSku).sort(),
      ["MISH-MMHOSE-RAM-98DBK", "MMHOSE-RAM-98DBK"]
    );
    assert.deepEqual(staged[0].missingSkus, []);
  }, vendorProducts);
});

test("prefers an exact sheet SKU over a fuzzy lookalike row", async () => {
  const vendorProducts = [
    {
      id: "vendor-product-oil-cooler",
      vendor_id: "vendor-1",
      product_id: "product-oil-cooler",
      product_sku: "MISH-MMOC-RAM-07",
      sku: "MMOC-RAM-07",
      label: "MMOC-RAM-07",
      quantity: 999999,
      status: 1
    }
  ];

  await withStagingHarness(async ({ staged, stageSheetAttachment }) => {
    await stageSheetAttachment({
      settings: stagingSettings,
      attachment: {
        filename: "Mishimoto_US_Inventory.csv",
        contentType: "text/csv",
        content: Buffer.from(
          "Item,Available\nMMAF-RAM-07,0\nMMOC-RAM-07,25\n"
        )
      },
      message: { uid: "gmail-mish", messageId: "message-mish" }
    });

    assert.equal(staged[0].rows.length, 1);
    assert.equal(staged[0].rows[0].sheetSku, "MMOC-RAM-07");
    assert.equal(staged[0].rows[0].inventoryValue, "25");
    assert.equal(staged[0].rows[0].proposedQuantity, 999999);
  }, vendorProducts);
});

test("captures an ATS SKU after its colon-delimited application label", async () => {
  const vendorProducts = [
    {
      id: "vendor-product-ats",
      vendor_id: "vendor-ats",
      product_id: "product-ats",
      product_sku: "ATS-309-914-8380",
      sku: "309-914-8380",
      label: "309-914-8380",
      quantity: 0,
      status: 1
    }
  ];

  await withStagingHarness(async ({ staged, stageSheetAttachment }) => {
    const result = await stageSheetAttachment({
      settings: { ...stagingSettings, vendorId: "vendor-ats" },
      attachment: {
        filename: "PPU Update 9-9.csv",
        contentType: "text/csv",
        content: Buffer.from("Item,Available\n306-10 : 309-914-8380,2\n")
      },
      message: { uid: "gmail-ats", messageId: "message-ats" }
    });

    assert.equal(result.autoApply, true);
    assert.equal(staged[0].summary.missingSkuRows, 0);
    assert.equal(staged[0].rows.length, 1);
    assert.equal(staged[0].rows[0].productSku, "ATS-309-914-8380");
    assert.equal(staged[0].rows[0].sheetSku, "306-10 : 309-914-8380");
    assert.equal(staged[0].rows[0].inventoryValue, "2");
    assert.equal(staged[0].rows[0].proposedQuantity, 999999);
  }, vendorProducts);
});

test("stages changed headers as needs mapping", async () => {
  await withStagingHarness(async ({ staged, stageSheetAttachment }) => {
    const result = await stageSheetAttachment({
      settings: stagingSettings,
      attachment: {
        filename: "inventory.csv",
        contentType: "text/csv",
        content: Buffer.from("Part Number,Qty Available\nVENDOR-100,12\n")
      },
      message: { uid: "gmail-2", messageId: "message-2" }
    });

    assert.equal(result.errors, 1);
    assert.equal(staged[0].summary.status, "needs_mapping");
    assert.deepEqual(staged[0].summary.availableHeaders, [
      "Part Number",
      "Qty Available"
    ]);
    assert.deepEqual(staged[0].summary.previewRows, [["VENDOR-100", "12"]]);
  });
});

test("searches every original spreadsheet column before paging", () => {
  const result = _test.createSheetData(
    [
      { SKU: "ONE", Stock: "0", Note: "ordinary" },
      { SKU: "TWO", Stock: "4", Note: "Find this value" }
    ],
    { page: 1, limit: 100, search: "find THIS" }
  );

  assert.deepEqual(result.availableHeaders, ["SKU", "Stock", "Note"]);
  assert.deepEqual(result.data, [["TWO", "4", "Find this value"]]);
  assert.equal(result.total, 1);
});

test("holds sheets with assigned StockBridge SKUs missing for review", async () => {
  const vendorProducts = [
    {
      id: "vendor-product-1",
      vendor_id: "vendor-1",
      product_id: "product-1",
      product_sku: "DPP-100",
      sku: "VENDOR-100",
      label: "VENDOR-100",
      quantity: 0
    },
    {
      id: "vendor-product-2",
      vendor_id: "vendor-1",
      product_id: "product-2",
      product_sku: "DPP-200",
      sku: "VENDOR-200",
      label: "VENDOR-200",
      quantity: 0
    }
  ];

  await withStagingHarness(async ({ staged, stageSheetAttachment }) => {
    const result = await stageSheetAttachment({
      settings: stagingSettings,
      attachment: {
        filename: "inventory.csv",
        contentType: "text/csv",
        content: Buffer.from("Item,Available\nVENDOR-100,12\n")
      },
      message: { uid: "gmail-3", messageId: "message-3" }
    });

    assert.equal(result.autoApply, false);
    assert.equal(staged[0].summary.status, "ready_for_review");
    assert.equal(staged[0].summary.missingSkuRows, 1);
    assert.deepEqual(staged[0].missingSkus, [
      {
        vendorProductId: "vendor-product-2",
        productId: "product-2",
        productSku: "DPP-200",
        vendorSku: "VENDOR-200"
      }
    ]);
  }, vendorProducts);
});

test("reactivates a missing-sheet exception when it appears later", async () => {
  await withStagingHarness(async ({ missingSheetExceptionUpdates, staged, stageSheetAttachment }) => {
    const result = await stageSheetAttachment({
      settings: {
        ...stagingSettings,
        missingSheetSkuExceptions: ["DPP-100"]
      },
      attachment: {
        filename: "inventory.csv",
        contentType: "text/csv",
        content: Buffer.from("Item,Available\nVENDOR-100,12\n")
      },
      message: { uid: "gmail-4", messageId: "message-4" }
    });

    assert.equal(result.autoApply, true);
    assert.equal(staged[0].rows.length, 1);
    assert.equal(missingSheetExceptionUpdates.length, 1);
    assert.equal(missingSheetExceptionUpdates[0][0], "vendor-1");
    assert.equal(missingSheetExceptionUpdates[0][2], false);
  });
});

test("keeps manual exceptions disabled when they appear on a later sheet", async () => {
  await withStagingHarness(async ({ missingSheetExceptionUpdates, staged, stageSheetAttachment }) => {
    const result = await stageSheetAttachment({
      settings: { ...stagingSettings, skuExceptions: ["DPP-100"] },
      attachment: {
        filename: "inventory.csv",
        contentType: "text/csv",
        content: Buffer.from("Item,Available\nVENDOR-100,12\n")
      },
      message: { uid: "gmail-5", messageId: "message-5" }
    });

    assert.equal(result.autoApply, true);
    assert.equal(staged[0].rows.length, 0);
    assert.equal(staged[0].summary.exceptionRows, 1);
    assert.equal(missingSheetExceptionUpdates.length, 0);
  });
});

test("does not apply a row removed from a sheet review", async () => {
  const productUpdatesPath = require.resolve(
    "./vendorAutoInventoryProductUpdates.service"
  );
  const importsPath = require.resolve("./vendorAutoInventoryImports.service");
  const paths = [
    servicePath,
    catalogPath,
    auditsPath,
    productsPath,
    productUpdatesPath,
    importsPath
  ];
  const originals = new Map(paths.map((path) => [path, require.cache[path]]));
  const statuses = [];
  const managedUpdates = [];
  let quantityWrites = 0;

  require.cache[catalogPath] = {
    id: catalogPath,
    filename: catalogPath,
    loaded: true,
    exports: {
      getActiveCatalogVendorProductsByVendorId: async () => [
        {
          id: "vendor-product-1",
          product_id: "product-1",
          product_sku: "DPP-100",
          quantity: 0
        }
      ]
    }
  };
  require.cache[auditsPath] = {
    id: auditsPath,
    filename: auditsPath,
    loaded: true,
    exports: {
      getAuditRecord: async () => ({
        id: "sheet-1",
        vendorId: "vendor-1",
        status: "approved",
        appliedCount: 0,
        mapping: { inventoryMode: "numerical" }
      }),
      getProposalRows: async () => [
        {
          rowNumber: 2,
          vendorProductId: "vendor-product-1",
          productId: "product-1",
          productSku: "DPP-100",
          sheetSku: "VENDOR-100",
          currentQuantity: 0,
          proposedQuantity: 999999,
          selected: false
        }
      ],
      setStatus: async (_auditId, status) => {
        statuses.push(status);
      }
    }
  };
  require.cache[productsPath] = {
    id: productsPath,
    filename: productsPath,
    loaded: true,
    exports: {
      setVendorProductQuantity: async () => {
        quantityWrites += 1;
      }
    }
  };
  require.cache[productUpdatesPath] = {
    id: productUpdatesPath,
    filename: productUpdatesPath,
    loaded: true,
    exports: {
      replaceVendorProductUpdatesForVendor: async (input) => {
        managedUpdates.push(input);
      }
    }
  };
  require.cache[importsPath] = {
    id: importsPath,
    filename: importsPath,
    loaded: true,
    exports: { recordImport: async () => ({ id: "legacy-1" }) }
  };
  delete require.cache[servicePath];

  try {
    const service = require(servicePath);
    const result = await service.applyStagedInventoryAudit("sheet-1");

    assert.equal(quantityWrites, 0);
    assert.equal(result.applied, 0);
    assert.equal(result.skipped, 1);
    assert.deepEqual(managedUpdates[0].updates, []);
    assert.deepEqual(statuses, ["applying", "applied"]);
  } finally {
    for (const path of paths) restoreModule(path, originals.get(path));
  }
});
