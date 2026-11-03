import type { ToolDef } from "./common.js";
import get_account from "./get_account.js";
import get_payment_details from "./get_payment_details.js";
import check_payments from "./check_payments.js";
import place_reorder from "./place_reorder.js";
import record_promise from "./record_promise.js";
import record_stock_check from "./record_stock_check.js";
import escalate_to_owner from "./escalate_to_owner.js";
import get_retailer_scorecard from "./get_retailer_scorecard.js";
import get_portfolio_report from "./get_portfolio_report.js";
import get_warehouse_stock from "./get_warehouse_stock.js";
import update_credit_limit from "./update_credit_limit.js";

export const TOOLS: ToolDef<any>[] = [
  get_account, get_payment_details, check_payments, place_reorder, record_promise, record_stock_check,
  escalate_to_owner, get_retailer_scorecard, get_portfolio_report, get_warehouse_stock, update_credit_limit,
];
