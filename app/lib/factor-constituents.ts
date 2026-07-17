/**
 * Factor-universe constituents — the measuring stick for cross-sectional
 * z-scores (Phase A of the factor layer). Hard-coded and VERSIONED here until
 * the FactSet benchmark-constituents entitlement (email Priority 5) lands,
 * then this file is replaced by the entitled feed.
 *
 * Membership drifts slowly (quarterly index reviews, occasional M&A) and the
 * universe is used ONLY for sector distribution stats (mean/std/percentiles
 * across ~60-80 names per sector) — a couple of stale entries move a sector
 * mean by basis points, so minor staleness is harmless. Refresh cadence:
 * quarterly, or when the entitled list arrives.
 *
 * Ticker conventions match the dashboard: bare = US listing, ".TO" = TSX —
 * resolveFactsetId in factor-universe handles FactSet id mapping (-US / -CA).
 *
 * LIST_VERSION bumps whenever membership is edited so pm:factor-universe can
 * record which vintage produced its stats.
 */

export const LIST_VERSION = "2026-07-a";

/** S&P 500 membership (approximate as of mid-2026 — see header). */
export const SP500: string[] = [
  "A","AAPL","ABBV","ABNB","ABT","ACGL","ACN","ADBE","ADI","ADM","ADP","ADSK","AEE","AEP","AES","AFL","AIG","AIZ","AJG","AKAM","ALB","ALGN","ALL","ALLE","AMAT","AMCR","AMD","AME","AMGN","AMP","AMT","AMZN","ANET","AON","AOS","APA","APD","APH","APTV","ARE","ATO","AVB","AVGO","AVY","AWK","AXON","AXP","AZO",
  "BA","BAC","BALL","BAX","BBY","BDX","BEN","BG","BIIB","BK","BKNG","BKR","BLDR","BLK","BMY","BR","BRK.B","BRO","BSX","BX","BXP",
  "C","CAG","CAH","CARR","CAT","CB","CBOE","CBRE","CCI","CCL","CDNS","CDW","CE","CEG","CF","CFG","CHD","CHRW","CHTR","CI","CINF","CL","CLX","CMCSA","CME","CMG","CMI","CMS","CNC","CNP","COF","COO","COP","COR","COST","CPAY","CPB","CPRT","CPT","CRL","CRM","CRWD","CSCO","CSGP","CSX","CTAS","CTRA","CTSH","CTVA","CVS","CVX","CZR",
  "D","DAL","DAY","DD","DE","DECK","DELL","DFS","DG","DGX","DHI","DHR","DIS","DLR","DLTR","DOC","DOV","DOW","DPZ","DRI","DTE","DUK","DVA","DVN","DXCM",
  "EA","EBAY","ECL","ED","EFX","EG","EIX","EL","ELV","EMN","EMR","ENPH","EOG","EPAM","EQIX","EQR","EQT","ERIE","ES","ESS","ETN","ETR","EVRG","EW","EXC","EXPD","EXPE","EXR",
  "F","FANG","FAST","FCX","FDS","FDX","FE","FFIV","FI","FICO","FIS","FITB","FOX","FOXA","FRT","FSLR","FTNT","FTV",
  "GD","GDDY","GE","GEHC","GEN","GEV","GILD","GIS","GL","GLW","GM","GNRC","GOOG","GOOGL","GPC","GPN","GRMN","GS","GWW",
  "HAL","HAS","HBAN","HCA","HD","HES","HIG","HII","HLT","HOLX","HON","HPE","HPQ","HRL","HSIC","HST","HSY","HUBB","HUM","HWM",
  "IBM","ICE","IDXX","IEX","IFF","INCY","INTC","INTU","INVH","IP","IPG","IQV","IR","IRM","ISRG","IT","ITW","IVZ",
  "J","JBHT","JBL","JCI","JKHY","JNJ","JNPR","JPM",
  "K","KDP","KEY","KEYS","KHC","KIM","KKR","KLAC","KMB","KMI","KMX","KO","KR","KVUE",
  "L","LDOS","LEN","LH","LHX","LIN","LKQ","LLY","LMT","LNT","LOW","LRCX","LULU","LUV","LVS","LW","LYB","LYV",
  "MA","MAA","MAR","MAS","MCD","MCHP","MCK","MCO","MDLZ","MDT","MET","META","MGM","MHK","MKC","MKTX","MLM","MMC","MMM","MNST","MO","MOH","MOS","MPC","MPWR","MRK","MRNA","MS","MSCI","MSFT","MSI","MTB","MTCH","MTD","MU",
  "NCLH","NDAQ","NDSN","NEE","NEM","NFLX","NI","NKE","NOC","NOW","NRG","NSC","NTAP","NTRS","NUE","NVDA","NVR","NWS","NWSA","NXPI",
  "O","ODFL","OKE","OMC","ON","ORCL","ORLY","OTIS","OXY",
  "PANW","PARA","PAYC","PAYX","PCAR","PCG","PEG","PEP","PFE","PFG","PG","PGR","PH","PHM","PKG","PLD","PLTR","PM","PNC","PNR","PNW","PODD","POOL","PPG","PPL","PRU","PSA","PSX","PTC","PWR","PYPL",
  "QCOM","QRVO",
  "RCL","REG","REGN","RF","RJF","RL","RMD","ROK","ROL","ROP","ROST","RSG","RTX","RVTY",
  "SBAC","SBUX","SCHW","SHW","SJM","SLB","SMCI","SNA","SNPS","SO","SOLV","SPG","SPGI","SRE","STE","STLD","STT","STX","STZ","SWK","SWKS","SYF","SYK","SYY",
  "T","TAP","TDG","TDY","TECH","TEL","TER","TFC","TGT","TJX","TMO","TMUS","TPR","TRGP","TRMB","TROW","TRV","TSCO","TSLA","TSN","TT","TTWO","TXN","TXT","TYL",
  "UAL","UBER","UDR","UHS","ULTA","UNH","UNP","UPS","URI","USB",
  "V","VICI","VLO","VLTO","VMC","VRSK","VRSN","VRTX","VST","VTR","VTRS","VZ",
  "WAB","WAT","WBA","WBD","WDC","WEC","WELL","WFC","WM","WMB","WMT","WRB","WST","WTW","WY","WYNN",
  "XEL","XOM","XYL",
  "YUM",
  "ZBH","ZBRA","ZTS",
];

/** S&P/TSX 60 membership (approximate as of mid-2026 — see header). */
export const TSX60: string[] = [
  "AEM.TO","AQN.TO","ATD.TO","BAM.TO","BCE.TO","BMO.TO","BN.TO","BNS.TO","ABX.TO","CAE.TO","CCL.B.TO","CCO.TO","CM.TO","CNQ.TO","CNR.TO","CP.TO","CSU.TO","CTC.A.TO","CVE.TO","DOL.TO","EMA.TO","ENB.TO","FM.TO","FNV.TO","FTS.TO","FTT.TO","GIB.A.TO","GIL.TO","H.TO","IFC.TO","IMO.TO","K.TO","L.TO","MFC.TO","MG.TO","MRU.TO","NA.TO","NTR.TO","OTEX.TO","POW.TO","PPL.TO","QSR.TO","RCI.B.TO","RY.TO","SAP.TO","SHOP.TO","SLF.TO","SU.TO","T.TO","TD.TO","TECK.B.TO","TFII.TO","TOU.TO","TRI.TO","TRP.TO","WCN.TO","WN.TO","WPM.TO","WSP.TO","X.TO",
];

/** The full universe, de-duplicated. */
export function universeTickers(): string[] {
  return Array.from(new Set([...SP500, ...TSX60]));
}
