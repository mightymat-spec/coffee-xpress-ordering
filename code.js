var LOYVERSE_TOKEN = PropertiesService.getScriptProperties().getProperty("LOYVERSE_TOKEN");

function doGet(e) {
  var callback = e && e.parameter && e.parameter.callback;

  try {
    var options = {
      "method": "get",
      "headers": {
        "Authorization": "Bearer " + LOYVERSE_TOKEN
      },
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

    // 1. Fetch Categories
    var rawCategories = fetchLoyversePaginated("categories", "categories");
    var categories = rawCategories.filter(function (cat) { return !cat.deleted_at; });

    // 2. Fetch All Items
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

    // 3. Fetch Modifiers
    var rawModifiers = fetchLoyversePaginated("modifiers", "modifiers");
    var modifiers = rawModifiers.filter(function (mod) { return !mod.deleted_at; });

    var responseData = {
      status: "success",
      categories: categories,
      items: items,
      modifiers: modifiers
    };

    return formatOutput(responseData, callback);

  } catch (err) {
    return formatOutput({ status: "error", message: err.toString() }, callback);
  }
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

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var sheet = getOrdersSheet_();
    var itemsSummary = (data.items || []).map(function (it) {
      var mods = (it.modifiers && it.modifiers.length) ? " +" + it.modifiers.join(", +") : "";
      var qty = it.quantity || 1;
      var variant = it.variant ? " (" + it.variant + ")" : "";
      return qty + "x " + (it.name || "") + variant + mods;
    }).join(" | ");

    sheet.appendRow([
      new Date(),
      data.customerName || "",
      data.date || "",
      data.time || "",
      itemsSummary,
      data.total || "",
      data.instructions || ""
    ]);

    return formatOutput({ status: "success" }, null);
  } catch (err) {
    return formatOutput({ status: "error", message: err.toString() }, null);
  }
}

function getOrdersSheet_() {
  var props = PropertiesService.getScriptProperties();
  var sheetId = props.getProperty("ORDERS_SHEET_ID");
  var ss = null;
  if (sheetId) {
    try {
      ss = SpreadsheetApp.openById(sheetId);
    } catch (e) {
      ss = null;
    }
  }
  if (!ss) {
    ss = SpreadsheetApp.create("Coffee Orders");
    props.setProperty("ORDERS_SHEET_ID", ss.getId());
    var sheet = ss.getSheets()[0];
    sheet.setName("Orders");
    sheet.appendRow(["Timestamp", "Customer Name", "Date", "Time", "Items", "Total", "Instructions"]);
  }
  return ss.getSheets()[0];
}

function testLoyverseSetup() {
  var options = {
    method: 'get',
    headers: { Authorization: 'Bearer ' + LOYVERSE_TOKEN },
    muteHttpExceptions: true
  };
  var out = {};
  ['stores','pos_devices','payment_types','employees'].forEach(function(ep){
    try {
      var res = UrlFetchApp.fetch('https://api.loyverse.com/v1.0/' + ep, options);
      out[ep] = { code: res.getResponseCode(), body: res.getContentText().substring(0,1500) };
    } catch(err) {
      out[ep] = { error: err.toString() };
    }
  });
  Logger.log(JSON.stringify(out, null, 2));
}
