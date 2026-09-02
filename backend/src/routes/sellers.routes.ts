import { Router } from "express";
import {
  getSellers,
  getSellerById,
  getSellerFinancialsSummary,
  getSellerFinancialsSummaryPremium,
  getSellerHistory,
  getSellerInventory,
  getSellerInventoryHealth,
  getSellerInventoryHealthDetailed,
  getSellerListings,
  getSellerLiveProducts,
  getSellerOrders,
  getSellerPpcSummary,
  getSellerProducts,
  getSellerSalesSummary,
  getSellerSkuProfitSummary,
  getSellerSources,
} from "../controllers/sellers.controller";

const router = Router();

router.get("/sellers", getSellers);
router.get("/sellers/:sellerId", getSellerById);
router.get("/sellers/:sellerId/sources", getSellerSources);
router.get("/sellers/:sellerId/history", getSellerHistory);
router.get("/sellers/:sellerId/products", getSellerProducts);
router.get("/sellers/:sellerId/listings", getSellerListings);
router.get("/sellers/:sellerId/inventory", getSellerInventory);
router.get("/sellers/:sellerId/inventory-health", getSellerInventoryHealth);
router.get("/sellers/:sellerId/inventory-health-detailed", getSellerInventoryHealthDetailed);
router.get("/sellers/:sellerId/orders", getSellerOrders);
router.get("/sellers/:sellerId/live-products", getSellerLiveProducts);
router.get("/sellers/:sellerId/sales-summary", getSellerSalesSummary);
router.get("/sellers/:sellerId/financials-summary", getSellerFinancialsSummary);
router.get("/sellers/:sellerId/financials-summary-premium", getSellerFinancialsSummaryPremium);
router.get("/sellers/:sellerId/ppc-summary", getSellerPpcSummary);
router.get("/sellers/:sellerId/sku-profit-summary", getSellerSkuProfitSummary);

export default router;
