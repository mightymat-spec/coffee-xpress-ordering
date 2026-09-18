/**
 * Coffee Express — Apps Script backend
 *
 * Endpoints (Web App /exec):
 *   GET  ?callback=cb                         -> menu (Loyverse) + store status  [public, JSONP]
 *   GET  ?action=status&callback=cb           -> { storeOpen, storeMessage }     [public, JSONP]
 *   GET  ?action=orders&key=PIN&callback=cb   -> { status, orders:[...] }         [PIN, JSONP]
 *   POST { action:'complete', row, key }      -> mark an order done               [PIN]
 *   POST { action:'reopen',   row, key }      -> undo a completed order           [PIN]
 *   POST { action:'setStatus', open, message, key } -> set store open/closed      [PIN]
 *   POST { ...order... }                      -> save a customer order            [public]
 *
 * Script Properties used:
 *   LOYVERSE_TOKEN   - Loyverse API token (already set)
 *   ORDERS_SHEET_ID  - Coffee Orders spreadsheet id (already set)
 *   KDS_PIN          - staff PIN for the kitchen display / toggle
 *   STORE_OPEN       - "true" / "false"  (defaults to open if unset)
 *   STORE_MESSAGE    - message shown to customers when closed
 *
 * Orders sheet columns (row 1 headers):
 *   1 Timestamp | 2 Customer Name | 3 pick up Date | 4 Pick up Time |
 *   5 Items | 6 Total | 7 Instructions | 8 Mobile | 9 Status |
 *   10 Completed At | 11 PickupISO
 */

var LOYVERSE_TOKEN = PropertiesService.getScriptProperties().getProperty("LOYVERSE_TOKEN");

var COL = {
  TIMESTAMP: 1,
  NAME: 2,
  DATE: 3,
  TIME: 4,
  ITEMS: 5,
  TOTAL: 6,
  INSTRUCTIONS: 7,
  MOBILE: 8,
  STATUS: 9,
  COMPLETED_AT: 10,
  PICKUP_ISO: 11
};
var LAST_COL = 11;

/* ------------------------------------------------------------------ */
/*  GET router                                                         */
/* ------------------------------------------------------------------ */
function doGet(e) {
  var params = (e && e.parameter) || {};
  var callback = params.callback;
  var action = params.action || "menu";

  try {
    if (action === "status") {
      return formatOutput(getStoreStatus_(), callback);
    }
    if (action === "orders") {
      requirePin_(params.key);
      return formatOutput({ status: "success", orders: listOrders_() }, callback);
    }
    // default: menu (+ store status bundled in)
    return formatOutput(getMenu_(), callback);
  } catch (err) {
    return formatOutput({ status: "error", message: err.toString() }, callback);
  }
}

/* ------------------------------------------------------------------ */
/*  POST router                                                        */
/* ------------------------------------------------------------------ */
function doPost(e) {
  var data;
  try {
    data = JSON.parse(e.postData.contents);
  } catch (err) {
    return formatOutput({ status: "error", message: "Invalid request." }, null);
  }

  try {
    var action = data.action || "order";

    if (action === "complete" || action === "reopen") {
      requirePin_(data.key);
      setOrderStatus_(data.row, action === "complete" ? "Done" : "New");
      return formatOutput({ status: "success" }, null);
    }

    if (action === "setStatus") {
      requirePin_(data.key);
      var props = PropertiesService.getScriptProperties();
      props.setProperty("STORE_OPEN", data.open ? "true" : "false");
      props.setProperty("STORE_MESSAGE", String(data.message || ""));
      return formatOutput({ status: "success", storeOpen: !!data.open, storeMessage: String(data.message || "") }, null);
    }

    // default: a customer order
    return saveOrder_(data);
  } catch (err) {
    return formatOutput({ status: "error", message: err.toString() }, null);
  }
}

/* ------------------------------------------------------------------ */
/*  Menu (Loyverse)                                                    */
/* ------------------------------------------------------------------ */
function getMenu_() {
  var status = getStoreStatus_();
  var base = { storeOpen: status.storeOpen, storeMessage: status.storeMessage };

  if (!LOYVERSE_TOKEN) {
    base.status = "success";
    base.categories = [];
    base.items = [];
    base.modifiers = [];
    return base;
  }

  var options = {
    "method": "get",
    "headers": { "Authorization": "Bearer " + LOYVERSE_TOKEN },
    "muteHttpExceptions": true
  };

  function fetchLoyversePaginated(endpoint, dataKey) {
    var results = [];
    var cursor = null;
    do {
      var url = "https://api.loyverse.com/v1.0/" + endpoint + "?limit=250" + (cursor ? "&cursor=" + cursor : "");
      var response = UrlFetchApp.fetch(url, options);
      var code = response.getResponseCode();
      var text = response.getContentText();
      if (code >= 400) {
        throw new Error("Loyverse API Error (" + code + "): " + text);
      }
      var parsed = JSON.parse(text);
      var items = parsed[dataKey] || [];
      results = results.concat(items);
      cursor = parsed.cursor || null;
    } while (cursor);
    return results;
  }

  var rawCategories = fetchLoyversePaginated("categories", "categories");
  var categories = rawCategories.filter(function (cat) { return !cat.deleted_at; });

  var rawItems = fetchLoyversePaginated("items", "items");
  var items = rawItems
    .filter(function (item) { return !item.deleted_at; })
    .map(function (item) {
      return {
        id: item.id,
        name: item.item_name || item.name || "Unnamed Drink",
        category_id: item.category_id || "",
        variants: item.variants || [],
        modifier_ids: item.modifier_ids || []
      };
    });

  var rawModifiers = fetchLoyversePaginated("modifiers", "modifiers");
  var modifiers = rawModifiers.filter(function (mod) { return !mod.deleted_at; });

  base.status = "success";
  base.categories = categories;
  base.items = items;
  base.modifiers = modifiers;
  return base;
}

/* ------------------------------------------------------------------ */
/*  Store open / closed                                                */
/* ------------------------------------------------------------------ */
function getStoreStatus_() {
  var props = PropertiesService.getScriptProperties();
  var open = props.getProperty("STORE_OPEN");
  // Default to OPEN if the property has never been set.
  var isOpen = (open === null || open === undefined) ? true : (open === "true");
  return {
    status: "success",
    storeOpen: isOpen,
    storeMessage: props.getProperty("STORE_MESSAGE") || ""
  };
}

/* ------------------------------------------------------------------ */
/*  Orders sheet                                                       */
/* ------------------------------------------------------------------ */
function getOrdersSheet_() {
  var props = PropertiesService.getScriptProperties();
  var sheetId = props.getProperty("ORDERS_SHEET_ID");
  var ss = null;
  if (sheetId) {
    try { ss = SpreadsheetApp.openById(sheetId); } catch (e) { ss = null; }
  }
  if (!ss) {
    ss = SpreadsheetApp.create("Coffee Orders");
    props.setProperty("ORDERS_SHEET_ID", ss.getId());
  }
  var sheet = ss.getSheets()[0];
  ensureHeaders_(sheet);
  return sheet;
}

function ensureHeaders_(sheet) {
  var headers = [
    "Timestamp", "Customer Name", "pick up Date", "Pick up Time",
    "Items", "Total", "Instructions", "Mobile", "Status",
    "Completed At", "PickupISO"
  ];
  var firstRow = sheet.getRange(1, 1, 1, LAST_COL).getValues()[0];
  var needs = false;
  for (var i = 0; i < headers.length; i++) {
    if (String(firstRow[i] || "").trim() !== headers[i]) { needs = true; break; }
  }
  if (needs) {
    sheet.getRange(1, 1, 1, LAST_COL).setValues([headers]);
    sheet.getRange(1, 1, 1, LAST_COL).setFontWeight("bold");
  }
}

function saveOrder_(data) {
  var status = getStoreStatus_();
  if (!status.storeOpen) {
    return formatOutput({
      status: "error",
      closed: true,
      message: status.storeMessage || "Online orders are currently closed. Please try again next open day."
    }, null);
  }

  var sheet = getOrdersSheet_();

  var itemsSummary = (data.items || []).map(function (it) {
    var mods = (it.modifiers && it.modifiers.length) ? " +" + it.modifiers.join(", +") : "";
    var qty = it.quantity || 1;
    var variant = it.variant ? " (" + it.variant + ")" : "";
    return qty + "x " + (it.name || "") + variant + mods;
  }).join("\n"); // one item per line

  var pickupIso = buildPickupIso_(data.date, data.time);

  var row = [
    new Date(),                 // 1 Timestamp
    data.customerName || "",    // 2 Customer Name
    data.date || "",            // 3 pick up Date
    data.time || "",            // 4 Pick up Time
    itemsSummary,               // 5 Items
    data.total || "",           // 6 Total
    data.instructions || "",    // 7 Instructions
    data.mobile || "",          // 8 Mobile
    "New",                      // 9 Status
    "",                         // 10 Completed At
    pickupIso                   // 11 PickupISO
  ];

  sheet.appendRow(row);

  // Wrap the Items cell so the newlines display nicely.
  var lastRow = sheet.getLastRow();
  sheet.getRange(lastRow, COL.ITEMS).setWrap(true);

  return formatOutput({ status: "success" }, null);
}

function listOrders_() {
  var sheet = getOrdersSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  var values = sheet.getRange(2, 1, lastRow - 1, LAST_COL).getValues();
  var display = sheet.getRange(2, 1, lastRow - 1, LAST_COL).getDisplayValues();
  var out = [];

  for (var i = 0; i < values.length; i++) {
    var v = values[i];
    var d = display[i];
    var name = String(v[COL.NAME - 1] || "").trim();
    var items = String(v[COL.ITEMS - 1] || "").trim();
    // Skip the leftover blank spacer rows.
    if (!name && !items) continue;

    var iso = String(v[COL.PICKUP_ISO - 1] || "").trim();
    if (!iso) {
      iso = buildPickupIso_(d[COL.DATE - 1], d[COL.TIME - 1]); // fallback for old rows
    }

    out.push({
      row: i + 2,
      timestamp: d[COL.TIMESTAMP - 1] || "",
      name: name,
      date: d[COL.DATE - 1] || "",
      time: d[COL.TIME - 1] || "",
      items: items,
      total: d[COL.TOTAL - 1] || "",
      instructions: String(v[COL.INSTRUCTIONS - 1] || ""),
      mobile: String(v[COL.MOBILE - 1] || "").trim(),
      status: String(v[COL.STATUS - 1] || "New").trim() || "New",
      completedAt: d[COL.COMPLETED_AT - 1] || "",
      pickupIso: iso
    });
  }
  return out;
}

function setOrderStatus_(row, newStatus) {
  row = parseInt(row, 10);
  var sheet = getOrdersSheet_();
  if (!row || row < 2 || row > sheet.getLastRow()) {
    throw new Error("Order row not found.");
  }
  sheet.getRange(row, COL.STATUS).setValue(newStatus);
  sheet.getRange(row, COL.COMPLETED_AT).setValue(newStatus === "Done" ? new Date() : "");
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Combine a pickup date + time into an ISO datetime string in the
 * script's timezone. Handles "YYYY-MM-DD" dates and both "8:00 AM"
 * and "08:00" time formats (and blank).
 */
function buildPickupIso_(dateStr, timeStr) {
  dateStr = String(dateStr || "").trim();
  timeStr = String(timeStr || "").trim();
  if (!dateStr) return "";

  // date: expect YYYY-MM-DD, but tolerate DD/MM/YYYY
  var y, mo, da;
  var iso = dateStr.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  var dmy = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (iso) { y = +iso[1]; mo = +iso[2]; da = +iso[3]; }
  else if (dmy) { y = +dmy[3]; mo = +dmy[2]; da = +dmy[1]; }
  else { return ""; }

  var h = 0, mi = 0;
  var ampm = timeStr.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  var h24 = timeStr.match(/^(\d{1,2}):(\d{2})$/);
  if (ampm) {
    h = +ampm[1]; mi = +ampm[2];
    var p = ampm[3].toUpperCase();
    if (p === "PM" && h < 12) h += 12;
    if (p === "AM" && h === 12) h = 0;
  } else if (h24) {
    h = +h24[1]; mi = +h24[2];
  }

  var tz = "Australia/Melbourne"; // café is in Emerald, VIC — keep pickup times local
  var d = new Date(y, mo - 1, da, h, mi, 0);
  return Utilities.formatDate(d, tz, "yyyy-MM-dd'T'HH:mm:ssXXX");
}

function requirePin_(key) {
  var pin = PropertiesService.getScriptProperties().getProperty("KDS_PIN");
  if (!pin) throw new Error("Staff PIN not configured.");
  if (String(key || "") !== String(pin)) throw new Error("Unauthorised.");
}

function formatOutput(data, callback) {
  var output = JSON.stringify(data);
  if (callback) {
    return ContentService.createTextOutput(callback + "(" + output + ")")
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(output)
    .setMimeType(ContentService.MimeType.JSON);
}

/* ------------------------------------------------------------------ */
/*  One-off setup helper — run once from the editor to set the PIN.    */
/* ------------------------------------------------------------------ */
function setup_setPin() {
  // Change "1234" then run this once, then delete the value again if you like.
  PropertiesService.getScriptProperties().setProperty("KDS_PIN", "1234");
}

function testLoyverseSetup() {
  var options = {
    method: 'get',
    headers: { Authorization: 'Bearer ' + LOYVERSE_TOKEN },
    muteHttpExceptions: true
  };
  var out = {};
  ['stores', 'pos_devices', 'payment_types', 'employees'].forEach(function (ep) {
    try {
      var res = UrlFetchApp.fetch('https://api.loyverse.com/v1.0/' + ep, options);
      out[ep] = { code: res.getResponseCode(), body: res.getContentText().substring(0, 1500) };
    } catch (err) {
      out[ep] = { error: err.toString() };
    }
  });
  Logger.log(JSON.stringify(out, null, 2));
}
