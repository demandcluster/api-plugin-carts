import getRateObjectForRate from "@reactioncommerce/api-utils/getRateObjectForRate.js";

/**
 * @summary Transform a single fulfillment group
 * @param {Object} fulfillmentGroup Fulfillment group
 * @param {Object} cart Full cart document, with items already transformed
 * @returns {Object} Transformed group
 */
function xformCartFulfillmentGroup(fulfillmentGroup, cart) {
  const availableFulfillmentOptions = (fulfillmentGroup.shipmentQuotes || []).map((option) => ({
    fulfillmentMethod: {
      _id: option.method._id,
      carrier: option.method.carrier || null,
      displayName: option.method.label || option.method.name,
      group: option.method.group || null,
      name: option.method.name,
      fulfillmentTypes: option.method.fulfillmentTypes
    },
    handlingPrice: {
      amount: option.handlingPrice || 0,
      currencyCode: cart.currencyCode
    },
    shippingPrice: {
      amount: option.shippingPrice || 0,
      currencyCode: cart.currencyCode
    },
    price: {
      amount: (option.rate + option.handlingPrice) || 0,
      currencyCode: cart.currencyCode
    }
  }));

  let selectedFulfillmentOption = null;
  if (fulfillmentGroup.shipmentMethod) {
    selectedFulfillmentOption = {
      fulfillmentMethod: {
        _id: fulfillmentGroup.shipmentMethod._id,
        carrier: fulfillmentGroup.shipmentMethod.carrier || null,
        displayName: fulfillmentGroup.shipmentMethod.label || fulfillmentGroup.shipmentMethod.name,
        group: fulfillmentGroup.shipmentMethod.group || null,
        name: fulfillmentGroup.shipmentMethod.name,
        fulfillmentTypes: fulfillmentGroup.shipmentMethod.fulfillmentTypes
      },
      handlingPrice: {
        amount: fulfillmentGroup.shipmentMethod.handling || 0,
        currencyCode: cart.currencyCode
      },
      price: {
        amount: (fulfillmentGroup.shipmentMethod.rate + fulfillmentGroup.shipmentMethod.handling) || 0,
        currencyCode: cart.currencyCode
      }
    };
  }

  return {
    _id: fulfillmentGroup._id,
    availableFulfillmentOptions,
    data: {
      shippingAddress: fulfillmentGroup.address
    },
    // For now, we only ever set one fulfillment group, so it has all of the items.
    // Revisit when the UI supports breaking into multiple groups.
    items: cart.items.filter(({ _id }) => fulfillmentGroup.itemIds.includes(_id)),
    selectedFulfillmentOption,
    shippingAddress: fulfillmentGroup.address,
    shopId: fulfillmentGroup.shopId,
    // For now, this is always shipping. Revisit when adding download, pickup, etc. types
    type: "shipping"
  };
}

/**
 * @summary The taxes support two pricing modes: pre-tax after-tax pricing.
 * When pre-tax is enabled, all defined prices of products, shipment and surcharges the tax is calculated onto do not
 * include the tax.
 *
 * Pre-tax Pricing Example: Product costs 100$ and shipping is 5$. The total price not including tax is 105$.
 * An example tax of 20% is calculated for the 105$ and the total becomes 105$ + 20% * 105$ = 126$
 *
 * After-tax Pricing Example: Product costs 100$ and shipping is 5$. When a tax of 20% is used for the shop with the
 * after-tax pricing model this means the 20% tax is already included in the 105$ total price. In this case the total
 * tax should not be added to the combined total.
 * @param {Object[]} taxes - all applied taxes for cart
 * @returns {number} tax total for all pre-tax pricing taxes.
 */
function calculatePreTaxPricingTaxTotal(taxes) {
  let preTaxPricingTaxTotal = 0;

  if (!taxes) return 0;

  for (const { tax, customFields } of taxes) {
    if (tax === null) return 0;
    if (!customFields || !customFields.afterTaxPricing) preTaxPricingTaxTotal += tax;
  }

  return preTaxPricingTaxTotal;
}

/**
 * @param {Object} collections Map of Mongo collections
 * @param {Object} cart Cart document
 * @returns {Object} Checkout object
 */
export default async function xformCartCheckout(collections, cart) {
  // itemTotal is qty * amount for each item, summed
  const itemTotal = (cart.items || []).reduce((sum, item) => (sum + item.subtotal.amount), 0);

  // shippingTotal is shipmentMethod.rate for each item, summed
  // handlingTotal is shipmentMethod.handling for each item, summed
  // If there are no selected shipping methods, fulfillmentTotal should be null
  let fulfillmentGroups = cart.shipping || [];
  let fulfillmentTotal = null;
  if (fulfillmentGroups.length > 0) {
    let shippingTotal = 0;
    let handlingTotal = 0;

    let hasNoSelectedShipmentMethods = true;
    fulfillmentGroups.forEach((fulfillmentGroup) => {
      if (fulfillmentGroup.shipmentMethod) {
        hasNoSelectedShipmentMethods = false;
        shippingTotal += fulfillmentGroup.shipmentMethod.rate || 0;
        handlingTotal += fulfillmentGroup.shipmentMethod.handling || 0;
      }
    });

    if (!hasNoSelectedShipmentMethods) {
      fulfillmentTotal = shippingTotal + handlingTotal;
    }
  }

  let taxes;
  let taxTotal = null;
  let taxableAmount = null;
  const { taxSummary } = cart;
  if (taxSummary) {
    ({ tax: taxTotal, taxableAmount, taxes } = taxSummary);
  }

  const preTaxPricingTaxTotal = calculatePreTaxPricingTaxTotal(taxes);

  const discountTotal = cart.discount || 0;

  // surchargeTotal is sum of all surcharges is qty * amount for each item, summed
  const surchargeTotal = (cart.surcharges || []).reduce((sum, surcharge) => (sum + surcharge.amount), 0);

  const total = Math.max(0, itemTotal + fulfillmentTotal + preTaxPricingTaxTotal + surchargeTotal - discountTotal);

  let fulfillmentTotalMoneyObject = null;
  if (fulfillmentTotal !== null) {
    fulfillmentTotalMoneyObject = {
      amount: fulfillmentTotal,
      currencyCode: cart.currencyCode
    };
  }

  let taxTotalMoneyObject = null;
  let effectiveTaxRateObject = null;
  if (taxTotal !== null) {
    taxTotalMoneyObject = {
      amount: taxTotal,
      currencyCode: cart.currencyCode
    };
    if (taxSummary) {
      const effectiveTaxRate = taxSummary.tax / taxSummary.taxableAmount;
      effectiveTaxRateObject = getRateObjectForRate(effectiveTaxRate);
    }
  }

  fulfillmentGroups = fulfillmentGroups.map((fulfillmentGroup) => xformCartFulfillmentGroup(fulfillmentGroup, cart));
  fulfillmentGroups = fulfillmentGroups.filter((group) => !!group); // filter out nulls

  return {
    fulfillmentGroups,
    summary: {
      discountTotal: {
        amount: discountTotal,
        currencyCode: cart.currencyCode
      },
      effectiveTaxRate: effectiveTaxRateObject,
      fulfillmentTotal: fulfillmentTotalMoneyObject,
      itemTotal: {
        amount: itemTotal,
        currencyCode: cart.currencyCode
      },
      taxableAmount: {
        amount: taxableAmount,
        currencyCode: cart.currencyCode
      },
      taxTotal: taxTotalMoneyObject,
      surchargeTotal: {
        amount: surchargeTotal,
        currencyCode: cart.currencyCode
      },
      total: {
        amount: total,
        currencyCode: cart.currencyCode
      }
    }
  };
}
