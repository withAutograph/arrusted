import { enumFieldFromLookupSeedRows, type ModelBlock } from "@domain-libs/_shared";

import { SUBSCRIPTION_STATUS_SEED_ROWS } from "./lookup-revenue";

/**
 * Revenue model definitions.
 *
 * Stripe-object-first support for subscription accrual workflows.
 * Scope intentionally excludes legacy Stripe plan/invoice objects.
 */

// ---------------------------------------------------------------------------
// Product
// ---------------------------------------------------------------------------

const product_block: ModelBlock = {
  name: "product",
  kind: "entity",
  label: "Product",
  // Suggested UI clusters: product_summary (id, object, name, active, default_price, description, created_at, updated_at, livemode, images, marketing_features, metadata, package_dimensions, shippable, statement_descriptor, tax_code, unit_label, url).
  fields: {
    // Previously essential.
    id: {
      type: "text",
      label: "Product ID",
      is_unique: true,
    },
    object: {
      type: "text",
      label: "Object Type",
    },
    name: {
      type: "text",
      label: "Product Name",
    },
    active: {
      type: "bool",
      label: "Active",
    },
    default_price: {
      target_model: "price",
      label: "Default Price",
    },
    description: {
      type: "text",
      label: "Description",
    },
    created_at: {
      type: "date",
      label: "Created At",
    },
    updated_at: {
      type: "date",
      label: "Updated At",
    },
    livemode: {
      type: "bool",
      label: "Live Mode",
    },
    // Previously templated.
    images: {
      type: "json",
      label: "Images",
    },
    marketing_features: {
      type: "json",
      label: "Marketing Features",
    },
    metadata: {
      type: "json",
      label: "Metadata",
    },
    package_dimensions: {
      type: "json",
      label: "Package Dimensions",
    },
    shippable: {
      type: "bool",
      label: "Shippable",
    },
    statement_descriptor: {
      type: "text",
      label: "Statement Descriptor",
    },
    tax_code: {
      type: "text",
      label: "Tax Code",
    },
    unit_label: {
      type: "text",
      label: "Unit Label",
    },
    url: {
      type: "text",
      label: "URL",
    },
  },
};

// ---------------------------------------------------------------------------
// Price
// ---------------------------------------------------------------------------

const price_block: ModelBlock = {
  name: "price",
  kind: "entity",
  label: "Price",
  // Suggested UI clusters: price_summary (id, object, product, active, billing_scheme, currency, type, unit_amount, unit_amount_decimal, created_at, livemode, lookup_key, nickname, metadata, tax_behavior, currency_options, custom_unit_amount, tiers, tiers_mode, transform_quantity); price_recurring (recurring_interval, recurring_interval_count, recurring_usage_type, recurring_meter).
  fields: {
    // Previously essential.
    id: {
      type: "text",
      label: "Price ID",
      is_unique: true,
    },
    object: {
      type: "text",
      label: "Object Type",
    },
    product: {
      target_model: "product",
      label: "Product",
    },
    active: {
      type: "bool",
      label: "Active",
    },
    billing_scheme: {
      type: "text",
      label: "Billing Scheme",
    },
    currency: {
      type: "iso_currency",
      label: "Currency",
    },
    type: {
      type: "text",
      label: "Type",
      notes: "one_time or recurring",
    },
    unit_amount: {
      type: "money_rate",
      label: "Unit Amount",
    },
    unit_amount_decimal: {
      type: "text",
      label: "Unit Amount Decimal (cents)",
    },
    created_at: {
      type: "date",
      label: "Created At",
    },
    livemode: {
      type: "bool",
      label: "Live Mode",
    },
    // Previously templated.
    lookup_key: {
      type: "text",
      label: "Lookup Key",
    },
    nickname: {
      type: "text",
      label: "Nickname",
    },
    metadata: {
      type: "json",
      label: "Metadata",
    },
    tax_behavior: {
      type: "text",
      label: "Tax Behavior",
    },
    currency_options: {
      type: "json",
      label: "Currency Options",
    },
    custom_unit_amount: {
      type: "json",
      label: "Custom Unit Amount",
    },
    tiers: {
      type: "json",
      label: "Tiers",
    },
    tiers_mode: {
      type: "text",
      label: "Tiers Mode",
    },
    transform_quantity: {
      type: "json",
      label: "Transform Quantity",
    },
    recurring_interval: {
      type: "text",
      label: "Recurring Interval",
    },
    recurring_interval_count: {
      type: "number",
      label: "Recurring Interval Count",
    },
    recurring_usage_type: {
      type: "text",
      label: "Recurring Usage Type",
    },
    recurring_meter: {
      type: "text",
      label: "Recurring Meter",
    },
  },
};

// ---------------------------------------------------------------------------
// Customer
// ---------------------------------------------------------------------------

const customer_block: ModelBlock = {
  name: "customer",
  kind: "entity",
  label: "Customer",
  // Suggested UI clusters: customer_summary (id, object, name, email, currency, created_at, livemode, description, phone, metadata, address, shipping, preferred_locales, default_source, delinquent, balance, tax_exempt, total_monthly_revenue, first_subscription_date).
  fields: {
    // Previously essential.
    id: {
      type: "text",
      label: "Customer ID",
      is_unique: true,
    },
    object: {
      type: "text",
      label: "Object Type",
    },
    name: {
      type: "text",
      label: "Name",
    },
    email: {
      type: "text",
      label: "Email",
    },
    currency: {
      type: "iso_currency",
      label: "Currency",
    },
    created_at: {
      type: "date",
      label: "Created At",
    },
    livemode: {
      type: "bool",
      label: "Live Mode",
    },
    // Previously templated.
    description: {
      type: "text",
      label: "Description",
    },
    phone: {
      type: "text",
      label: "Phone",
    },
    metadata: {
      type: "json",
      label: "Metadata",
    },
    address: {
      type: "json",
      label: "Address",
    },
    shipping: {
      type: "json",
      label: "Shipping",
    },
    preferred_locales: {
      type: "json",
      label: "Preferred Locales",
    },
    default_source: {
      type: "text",
      label: "Default Source",
    },
    delinquent: {
      type: "bool",
      label: "Delinquent",
    },
    balance: {
      type: "number",
      label: "Balance",
    },
    tax_exempt: {
      type: "text",
      label: "Tax Exempt",
    },
    total_monthly_revenue: {
      type: "money_rate",
      label: "Total Monthly Revenue",
      notes: "Derived: sum of included USD subscriptions' recurring_monthly_amount",
    },
    first_subscription_date: {
      type: "date",
      label: "First Subscription",
      notes: "Derived: earliest start_date across all subscriptions",
    },
  },
};

// ---------------------------------------------------------------------------
// Subscription
// ---------------------------------------------------------------------------
//
// Stripe does not expose a first-class subscription-level total on the
// Subscription object. The nominal recurring amount for a subscription should
// be derived from its subscription items (price/unit amount * quantity), while
// actual billed totals should come from invoices later because discounts,
// taxes, prorations, and usage can change the charged amount.
//
// Follow-up work should keep `subscription` as the primary row grain and add
// derived rollups such as recurringAmount / annualized_amount here rather than
// switching the app's primary model to `subscriptionItem`.

const subscription_block: ModelBlock = {
  name: "subscription",
  kind: "entity",
  label: "Subscription",
  // Suggested UI clusters: subscription_summary (id, object, customer, livemode, metadata, description, application, created_at, customer_account, test_clock); subscription_billing (currency, items, current_period_start, current_period_end, billing_cycle_anchor, collection_method, recurring_monthly_amount, annualized_amount, application_fee_percent, automatic_tax, billing_mode, billing_thresholds, days_until_due, default_payment_method, default_source, default_tax_rates, discounts, on_behalf_of, payment_settings, pending_setup_intent, presentment_details, transfer_data); subscription_lifecycle (start_date, schedule, cancel_at, cancel_at_period_end, canceled_at, ended_at, pause_collection, pending_update, trial_start, trial_end, trial_settings, cancellation_details).
  fields: {
    // Previously essential.
    id: {
      type: "text",
      label: "Subscription ID",
      is_unique: true,
    },
    object: {
      type: "text",
      label: "Object Type",
    },
    status: enumFieldFromLookupSeedRows(SUBSCRIPTION_STATUS_SEED_ROWS, {
      label: "Status",
    }),
    customer: {
      target_model: "customer",
      label: "Customer",
    },
    currency: {
      type: "iso_currency",
      label: "Currency",
    },
    items: {
      target_model: "subscription_item",
      is_multi_value: true,
      label: "Items",
    },
    start_date: {
      type: "date",
      label: "Start Date",
      notes: "Stripe start_date",
    },
    current_period_start: {
      type: "date",
      label: "Current Period Start",
    },
    current_period_end: {
      type: "date",
      label: "Current Period End",
    },
    billing_cycle_anchor: {
      type: "date",
      label: "Billing Cycle Anchor",
    },
    collection_method: {
      type: "text",
      label: "Collection Method",
    },
    schedule: {
      target_model: "subscription_schedule",
      label: "Schedule",
    },
    cancel_at: {
      type: "date",
      label: "Cancel At",
    },
    cancel_at_period_end: {
      type: "bool",
      label: "Cancel at Period End",
    },
    canceled_at: {
      type: "date",
      label: "Canceled At",
    },
    ended_at: {
      type: "date",
      label: "Ended At",
    },
    livemode: {
      type: "bool",
      label: "Live Mode",
    },
    metadata: {
      type: "json",
      label: "Metadata",
    },
    description: {
      type: "text",
      label: "Description",
    },
    recurring_monthly_amount: {
      type: "money_rate",
      label: "Monthly Amount",
      notes: "Derived: sum of (item.qty × price.unit_amount) normalized to monthly",
    },
    annualized_amount: {
      type: "money_rate",
      label: "Annualized Amount",
      notes: "Derived: USD recurring_monthly_amount × 12",
    },
    // Previously templated.
    application: {
      type: "text",
      label: "Application",
    },
    application_fee_percent: {
      type: "number",
      label: "Application Fee Percent",
    },
    automatic_tax: {
      type: "json",
      label: "Automatic Tax",
    },
    billing_mode: {
      type: "json",
      label: "Billing Mode",
    },
    billing_thresholds: {
      type: "json",
      label: "Billing Thresholds",
    },
    created_at: {
      type: "date",
      label: "Created At",
    },
    customer_account: {
      type: "text",
      label: "Customer Account",
    },
    days_until_due: {
      type: "number",
      label: "Days Until Due",
    },
    default_payment_method: {
      type: "text",
      label: "Default Payment Method",
    },
    default_source: {
      type: "text",
      label: "Default Source",
    },
    default_tax_rates: {
      type: "json",
      label: "Default Tax Rates",
    },
    discounts: {
      type: "json",
      label: "Discounts",
    },
    on_behalf_of: {
      type: "text",
      label: "On Behalf Of",
    },
    pause_collection: {
      type: "json",
      label: "Pause Collection",
    },
    payment_settings: {
      type: "json",
      label: "Payment Settings",
    },
    pending_setup_intent: {
      type: "text",
      label: "Pending Setup Intent",
    },
    pending_update: {
      type: "json",
      label: "Pending Update",
    },
    presentment_details: {
      type: "json",
      label: "Presentment Details",
    },
    test_clock: {
      type: "text",
      label: "Test Clock",
    },
    transfer_data: {
      type: "json",
      label: "Transfer Data",
    },
    trial_start: {
      type: "date",
      label: "Trial Start",
    },
    trial_end: {
      type: "date",
      label: "Trial End",
    },
    trial_settings: {
      type: "json",
      label: "Trial Settings",
    },
    cancellation_details: {
      type: "json",
      label: "Cancellation Details",
    },
  },
};

// ---------------------------------------------------------------------------
// Subscription Item
// ---------------------------------------------------------------------------

const subscription_item_block: ModelBlock = {
  name: "subscription_item",
  kind: "entity",
  label: "Subscription Item",
  // Suggested UI clusters: subscription_item_summary (id, object, subscription, price, quantity, created_at, monthly_equivalent, discounts, metadata, tax_rates); subscription_item_period (current_period_start, current_period_end, billing_thresholds).
  fields: {
    // Previously essential.
    id: {
      type: "text",
      label: "Subscription Item ID",
      is_unique: true,
    },
    object: {
      type: "text",
      label: "Object Type",
    },
    subscription: {
      target_model: "subscription",
      label: "Subscription",
    },
    price: {
      target_model: "price",
      label: "Price",
    },
    quantity: {
      type: "number",
      label: "Quantity",
    },
    current_period_start: {
      type: "date",
      label: "Current Period Start",
    },
    current_period_end: {
      type: "date",
      label: "Current Period End",
    },
    created_at: {
      type: "date",
      label: "Created At",
    },
    monthly_equivalent: {
      type: "money_rate",
      label: "Monthly Equivalent",
      notes: "Derived: quantity × price.unit_amount normalized to monthly",
    },
    // Previously templated.
    billing_thresholds: {
      type: "json",
      label: "Billing Thresholds",
    },
    discounts: {
      type: "json",
      label: "Discounts",
    },
    metadata: {
      type: "json",
      label: "Metadata",
    },
    tax_rates: {
      type: "json",
      label: "Tax Rates",
    },
  },
};

// ---------------------------------------------------------------------------
// Subscription Schedule
// ---------------------------------------------------------------------------

const subscription_schedule_block: ModelBlock = {
  name: "subscription_schedule",
  kind: "entity",
  label: "Subscription Schedule",
  // Suggested UI clusters: subscription_schedule_summary (id, object, status, subscription, customer, end_behavior, default_settings, billing_mode, created_at, livemode, application, customer_account, metadata, canceled_at, completed_at, released_at, released_subscription, test_clock); subscription_schedule_phases (current_phase_start, current_phase_end, phases).
  fields: {
    // Previously essential.
    id: {
      type: "text",
      label: "Schedule ID",
      is_unique: true,
    },
    object: {
      type: "text",
      label: "Object Type",
    },
    status: {
      type: "text",
      label: "Status",
    },
    subscription: {
      target_model: "subscription",
      label: "Subscription",
    },
    customer: {
      target_model: "customer",
      label: "Customer",
    },
    end_behavior: {
      type: "text",
      label: "End Behavior",
    },
    current_phase_start: {
      type: "date",
      label: "Current Phase Start",
    },
    current_phase_end: {
      type: "date",
      label: "Current Phase End",
    },
    phases: {
      type: "json",
      label: "Phases",
    },
    default_settings: {
      type: "json",
      label: "Default Settings",
    },
    billing_mode: {
      type: "json",
      label: "Billing Mode",
    },
    created_at: {
      type: "date",
      label: "Created At",
    },
    livemode: {
      type: "bool",
      label: "Live Mode",
    },
    // Previously templated.
    application: {
      type: "text",
      label: "Application",
    },
    customer_account: {
      type: "text",
      label: "Customer Account",
    },
    metadata: {
      type: "json",
      label: "Metadata",
    },
    canceled_at: {
      type: "date",
      label: "Canceled At",
    },
    completed_at: {
      type: "date",
      label: "Completed At",
    },
    released_at: {
      type: "date",
      label: "Released At",
    },
    released_subscription: {
      type: "text",
      label: "Released Subscription",
    },
    test_clock: {
      type: "text",
      label: "Test Clock",
    },
  },
};

// ---------------------------------------------------------------------------
// Exported Block Array
// ---------------------------------------------------------------------------

export const model_revenue_blocks: ModelBlock[] = [
  product_block,
  price_block,
  customer_block,
  subscription_block,
  subscription_item_block,
  subscription_schedule_block,
];
