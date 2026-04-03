// ── Index constituent tickers for universe scanning ──
// These are approximate current constituents. Minor changes happen quarterly.

export type UniverseKey = "sp500" | "nasdaq100" | "tsx60";

export const UNIVERSE_LABELS: Record<UniverseKey, string> = {
  sp500: "S&P 500",
  nasdaq100: "NASDAQ 100",
  tsx60: "S&P/TSX 60",
};

// S&P 500 (approximate, ~500 tickers)
const SP500: string[] = [
  "AAPL","ABBV","ABT","ACN","ADBE","ADI","ADM","ADP","ADSK","AEE","AEP","AES","AFL","AIG","AIZ",
  "AJG","AKAM","ALB","ALGN","ALK","ALL","ALLE","AMAT","AMCR","AMD","AME","AMGN","AMP","AMT","AMZN",
  "ANET","ANSS","AON","AOS","APA","APD","APH","APTV","ARE","ATO","ATVI","AVB","AVGO","AVY","AWK",
  "AXP","AZO","BA","BAC","BAX","BBWI","BBY","BDX","BEN","BF.B","BIIB","BIO","BK","BKNG","BKR",
  "BLK","BMY","BR","BRK.B","BRO","BSX","BWA","BXP","C","CAG","CAH","CARR","CAT","CB","CBOE",
  "CBRE","CCI","CCL","CDAY","CDNS","CDW","CE","CEG","CF","CFG","CHD","CHRW","CHTR","CI","CINF",
  "CL","CLX","CMA","CMCSA","CME","CMG","CMI","CMS","CNC","CNP","COF","COO","COP","COST","CPB",
  "CPRT","CPT","CRL","CRM","CSCO","CSGP","CSX","CTAS","CTLT","CTRA","CTSH","CTVA","CVS","CVX",
  "CZR","D","DAL","DD","DE","DFS","DG","DGX","DHI","DHR","DIS","DISH","DLR","DLTR","DOV",
  "DOW","DPZ","DRI","DTE","DUK","DVA","DVN","DXC","DXCM","EA","EBAY","ECL","ED","EFX","EIX",
  "EL","EMN","EMR","ENPH","EOG","EPAM","EQIX","EQR","EQT","ES","ESS","ETN","ETR","ETSY","EVRG",
  "EW","EXC","EXPD","EXPE","EXR","F","FANG","FAST","FBHS","FCX","FDS","FDX","FE","FFIV","FIS",
  "FISV","FITB","FLT","FMC","FOX","FOXA","FRC","FRT","FTNT","FTV","GD","GE","GEHC","GEN","GILD",
  "GIS","GL","GLW","GM","GNRC","GOOG","GOOGL","GPC","GPN","GRMN","GS","GWW","HAL","HAS","HBAN",
  "HCA","HD","HOLX","HON","HPE","HPQ","HRL","HSIC","HST","HSY","HUM","HWM","IBM","ICE","IDXX",
  "IEX","IFF","ILMN","INCY","INTC","INTU","INVH","IP","IPG","IQV","IR","IRM","ISRG","IT","ITW",
  "IVZ","J","JBHT","JCI","JKHY","JNJ","JNPR","JPM","K","KDP","KEY","KEYS","KHC","KIM","KLAC",
  "KMB","KMI","KMX","KO","KR","L","LDOS","LEN","LH","LHX","LIN","LKQ","LLY","LMT","LNC",
  "LNT","LOW","LRCX","LUMN","LUV","LVS","LW","LYB","LYV","MA","MAA","MAR","MAS","MCD","MCHP",
  "MCK","MCO","MDLZ","MDT","MET","META","MGM","MHK","MKC","MKTX","MLM","MMC","MMM","MNST","MO",
  "MOH","MOS","MPC","MPWR","MRK","MRNA","MRO","MS","MSCI","MSFT","MSI","MTB","MTCH","MTD","MU",
  "NCLH","NDAQ","NDSN","NEE","NEM","NFLX","NI","NKE","NOC","NOW","NRG","NSC","NTAP","NTRS","NUE",
  "NVDA","NVR","NWL","NWS","NWSA","NXPI","O","ODFL","OGN","OKE","OMC","ON","ORCL","ORLY","OTIS",
  "OXY","PARA","PAYC","PAYX","PCAR","PCG","PEAK","PEG","PEP","PFE","PFG","PG","PGR","PH","PHM",
  "PKG","PKI","PLD","PM","PNC","PNR","PNW","POOL","PPG","PPL","PRU","PSA","PSX","PTC","PVH",
  "PWR","PXD","PYPL","QCOM","QRVO","RCL","RE","REG","REGN","RF","RHI","RJF","RL","RMD","ROK",
  "ROL","ROP","ROST","RSG","RTX","SBAC","SBNY","SBUX","SCHW","SEE","SHW","SIVB","SJM","SLB",
  "SNA","SNPS","SO","SPG","SPGI","SRE","STE","STT","STX","STZ","SWK","SWKS","SYF","SYK","SYY",
  "T","TAP","TDG","TDY","TECH","TEL","TER","TFC","TFX","TGT","TMO","TMUS","TPR","TRGP","TRMB",
  "TROW","TRV","TSCO","TSLA","TSN","TT","TTWO","TXN","TXT","TYL","UAL","UDR","UHS","ULTA","UNH",
  "UNP","UPS","URI","USB","V","VFC","VICI","VLO","VMC","VNO","VRSK","VRSN","VRTX","VTR","VTRS",
  "VZ","WAB","WAT","WBA","WBD","WDC","WEC","WELL","WFC","WHR","WM","WMB","WMT","WRB","WRK",
  "WST","WTW","WY","WYNN","XEL","XOM","XRAY","XYL","YUM","ZBH","ZBRA","ZION","ZTS",
];

// NASDAQ 100
const NASDAQ100: string[] = [
  "AAPL","ABNB","ADBE","ADI","ADP","ADSK","AEP","AMAT","AMD","AMGN","AMZN","ANSS","ARM","ASML",
  "AVGO","AZN","BIIB","BKNG","BKR","CDNS","CDW","CEG","CHTR","CMCSA","COST","CPRT","CRWD","CSCO",
  "CSGP","CSX","CTAS","CTSH","DASH","DDOG","DLTR","DXCM","EA","ENPH","EXC","FANG","FAST","FTNT",
  "GEHC","GFS","GILD","GOOG","GOOGL","HON","IDXX","ILMN","INTC","INTU","ISRG","KDP","KHC","KLAC",
  "LIN","LRCX","LULU","MAR","MCHP","MDB","MDLZ","MELI","META","MNST","MRNA","MRVL","MSFT","MU",
  "NFLX","NVDA","NXPI","ODFL","ON","ORLY","PANW","PAYX","PCAR","PDD","PEP","PYPL","QCOM","REGN",
  "ROST","SBUX","SIRI","SNPS","SPLK","TEAM","TMUS","TSLA","TTD","TTWO","TXN","VRSK","VRTX","WBA",
  "WBD","WDAY","XEL","ZS",
];

// S&P/TSX 60 (Canadian)
const TSX60: string[] = [
  "ABX.TO","AEM.TO","AGI.TO","AQN.TO","ARX.TO","ATD.TO","BAM.TO","BHC.TO","BMO.TO","BN.TO",
  "BNS.TO","CAE.TO","CAR-UN.TO","CCL-B.TO","CLS.TO","CM.TO","CNQ.TO","CNR.TO","CP.TO","CPX.TO",
  "CSU.TO","CTC-A.TO","CVE.TO","DOL.TO","DSG.TO","EMA.TO","ENB.TO","FFH.TO","FM.TO","FNV.TO",
  "FTS.TO","GIB-A.TO","GWO.TO","H.TO","IFC.TO","IMO.TO","K.TO","L.TO","MFC.TO","MG.TO",
  "MRU.TO","NA.TO","NTR.TO","ONEX.TO","OTEX.TO","POW.TO","PPL.TO","QSR.TO","RCI-B.TO","RY.TO",
  "SAP.TO","SLF.TO","SU.TO","T.TO","TD.TO","TFII.TO","TIH.TO","TRI.TO","TRP.TO","WCN.TO",
];

export const UNIVERSES: Record<UniverseKey, string[]> = {
  sp500: SP500,
  nasdaq100: NASDAQ100,
  tsx60: TSX60,
};
