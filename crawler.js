import { chromium } from "playwright-core";
import mongoose from "mongoose";
import Price from "./models/price.js"; // 확장자 포함 권장 (ESM 기준)
import EventValueChart from "./models/eventValueChart.js";
import PlayerReports from "./models/playerReports.js";
// import data from "./data.json" assert { type: "json" };
import dbConnect from "./dbConnect.js";
import HanTools from "hangul-tools";
import axios from "axios";

let browser;

async function initBrowser() {
  if (browser) {
    try {
      await browser.close();
      console.log("🔄 Previous browser closed");
    } catch (error) {
      console.error("⚠ Error closing previous browser:", error.message);
    }
  }

  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.NODE_ENV === "production"
        ? process.env.CHROME_EXECUTABLE_PATH || "/usr/bin/google-chrome-stable"
        : undefined,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-extensions",
      "--disable-gpu",
      "--no-zygote",
    ],
    ignoreHTTPSErrors: true,
  });

  console.log("✅ Playwright browser initialized");
}

// async function dbConnect() {
//   if (mongoose.connection.readyState !== 1) {
//     await mongoose.connect(process.env.MONGO_URI, {
//       useNewUrlParser: true,
//       useUnifiedTopology: true,
//     });
//     console.log("✅ MongoDB connected");
//   }
// }

async function blockUnwantedResources(page) {
  await page.route("**/*", (route) => {
    const blockedTypes = new Set(["image", "stylesheet", "font", "media"]);
    const blockedDomains = ["google-analytics.com", "doubleclick.net"];
    const url = route.request().url();

    if (
      blockedTypes.has(route.request().resourceType()) ||
      blockedDomains.some((domain) => url.includes(domain))
    ) {
      route.abort();
    } else {
      route.continue();
    }
  });
}

async function playerPriceValue(data, Grade) {
  let context;
  let grades;

  if (Array.isArray(Grade)) {
    grades = [...Grade];
  } else {
    grades = [Grade];
  }

  try {
    await initBrowser();
    context = await browser.newContext();
    const results = [];

    for (let grade of grades) {
      for (const player of data) {
        const { id } = player;
        const url = `https://fconline.nexon.com/DataCenter/PlayerInfo?spid=${id}&n1Strong=${grade}`;
        const page = await context.newPage();
        await blockUnwantedResources(page);

        try {
          console.log(`🌍 Navigating to ${url}`);
          await page.goto(url, { waitUntil: "domcontentloaded" });

          await page.waitForFunction(
            () => {
              const element = document.querySelector(".txt strong");
              return (
                element &&
                element.getAttribute("title") &&
                element.getAttribute("title").trim() !== ""
              );
            },
            { timeout: 80000 }
          );

          let datacenterTitle = await page.evaluate(() => {
            const element = document.querySelector(".txt strong").textContent;
            return element;
          });

          results.push({
            id: id,
            prices: { grade, price: datacenterTitle },
          });

          console.log(`✔ ID ${id} / Grade ${grade} → ${datacenterTitle}`);
        } catch (err) {
          console.error(`❌ Error for ID ${id}, Grade ${grade}:`, err.message);
          results.push({
            id: id,
            prices: { grade, price: "Error" },
          });
        } finally {
          await page.close();
        }
      }
    }

    return results;
  } finally {
    await context?.close();
    await browser?.close();
  }
}

async function saveToDB(results) {
  const bulkOps = results.map(({ id, prices }) => ({
    updateOne: {
      filter: { id: String(id), "prices.grade": prices.grade },
      update: {
        $set: { "prices.$[elem].price": prices.price },
      },
      arrayFilters: [{ "elem.grade": prices.grade }],
      upsert: true,
    },
  }));

  if (bulkOps.length > 0) {
    try {
      await Price.bulkWrite(bulkOps);
      console.log("📦 MongoDB updated");
    } catch (error) {
      console.error("❌ MongoDB bulkWrite failed:", error.message);
    }
  } else {
    console.log("⚠ No data to save");
  }
}

function SortAndSlice(result, slice) {
  let data = [...result];

  data.sort((a, b) => {
    const positionsA = Number(
      HanTools.parseNumber(a.prices.price.replace(",", ""))
    );
    const positionsB = Number(
      HanTools.parseNumber(b.prices.price.replace(",", ""))
    );

    return positionsB - positionsA;
  });

  if (slice !== undefined && slice !== null) {
    data = data.slice(0, slice);
  }

  return data;
}

const playerSearch = async (selectedSeason = "", minOvr = 0) => {
  let selectedSeasons;
  if (Array.isArray(selectedSeason)) {
    selectedSeasons = [...selectedSeason];
  } else {
    selectedSeasons = [selectedSeason];
  }
  const seasonNumbers = [];
  const inputplayer = "";

  // 이미 배열 형태로 전달된 selectedSeasons과 selectedPositions 사용

  for (let season of selectedSeasons) {
    seasonNumbers.push(Number(String(season).slice(-3)));
  }

  let playerReports = [];

  const queryCondition = [{ name: new RegExp(inputplayer) }];

  if (minOvr && minOvr > 10) {
    queryCondition.push({
      "능력치.포지션능력치.최고능력치": {
        $gte: Number(minOvr),
      },
    });
  }

  if (seasonNumbers && seasonNumbers.length > 0) {
    for (let seasonNumber of seasonNumbers) {
      seasonNumber *= 1000000;

      const seasonCondition = {
        id: {
          $gte: seasonNumber,
          $lte: seasonNumber + 999999,
        },
      };

      queryCondition.push(seasonCondition);

      let playerReport = await PlayerReports.find({
        $and: queryCondition,
      })
        .populate({
          path: "선수정보",
          populate: {
            path: "prices", // 중첩된 필드를 처리
            model: "Price",
          },
        })
        .populate({
          path: "선수정보.시즌이미지",
          populate: {
            path: "시즌이미지",
            model: "SeasonId",
          },
        })
        .sort({ "능력치.포지션능력치.포지션최고능력치": -1 })
        .limit(10000);
      queryCondition.pop();
      playerReports = playerReports.concat(playerReport);
    }
  } else {
    let playerReport = await PlayerReports.find({
      $and: queryCondition,
    })
      .populate({
        path: "선수정보",
        populate: {
          path: "prices", // 중첩된 필드를 처리
          model: "Price",
        },
      })
      .populate({
        path: "선수정보.시즌이미지",
        populate: {
          path: "시즌이미지",
          model: "SeasonId",
        },
      })
      .sort({ "능력치.포지션능력치.포지션최고능력치": -1 })
      .limit(10000);

    playerReports = playerReports.concat(playerReport);
  }

  return playerReports;
};

async function main() {
  try {
    const data = {
      id: "챔피언스 저니 4000p",
      updateTime: "",
      seasonPack: [],
    };

    const BOE21_TOP_100 = {
      packName: "BOE21 클래스 Top Price 100 스페셜팩 (10강, 90+)",
      playerPrice: [],
    };
    const MC_TOP_70 = {
      packName: "MC 클래스 Top Price 70 스페셜팩 (10강, 90+)",
      playerPrice: [],
    };
    const LN_TOP_85 = {
      packName: "LN 클래스 Top Price 85 스페셜팩 (9강, 103+)",
      playerPrice: [],
    };
    const HG_TOP_90 = {
      packName: "HG 클래스 Top Price 90 스페셜팩 (9강, 103+)",
      playerPrice: [],
    };
    const RTN_TOP_65 = {
      packName: "RTN 클래스 Top Price 65 스페셜팩 (9강, 99+)",
      playerPrice: [],
    };
    const LOL_FA_TOP_50 = {
      packName: "LOL, FA Top Price 50 스페셜팩 (9강, 103+)",
      playerPrice: [],
    };
    const HR22_TOP_110 = {
      packName: "22HEROES, BTB 포함 Top Price 110 스페셜팩 (9강, 103+)",
      playerPrice: [],
    };
    const COC_OTW_TOP_50 = {
      packName: "COC, OTW 포함 Top Price 50 스페셜팩 (10강, 75+)",
      playerPrice: [],
    };
    const ICONS_MATCHANDICON = {
      packName: "ICONS MATCH 포함 Top Price 550 스페셜팩 (5~8강, 111+)",
      playerPrice: [],
    };

    await dbConnect();

    // // -------------------------------------- ICON_TOP_ALL--------------------------------------

    // const ICONTM_LIST = await playerSearch([100], 0); // playerSearch(시즌넘버, 최소오버롤)
    // let ICONTM_RESULTS = await playerPriceValue(ICONTM_LIST, 5); // playerPriceValue(데이터 , 강화등급)
    // await saveToDB(ICONTM_RESULTS);
    // const ICONTM_FINAL = SortAndSlice(ICONTM_RESULTS); // SortAndSlice(데이터 , 자르기숫자)

    // for (let item of ICONTM_FINAL) {
    //   const playerDocs = await Price.find({ id: item.id });
    //   if (playerDocs.length > 0 && playerDocs[0]._id) {
    //     const playerData = {
    //       grade: item.prices.grade,
    //       playerPrice: playerDocs[0]?._id || null,
    //     };
    //     ICON_TM_TOP_ALL.playerPrice.push(playerData);
    //   }
    // }
    // data.seasonPack.push({ ...ICON_TM_TOP_ALL });
    // -------------------------------------- BOE21_TOP_100--------------------------------------

    const BOE_LIST = await playerSearch([253], 90); // playerSearch(시즌넘버, 최소오버롤)
    let BOE_RESULTS = await playerPriceValue(BOE_LIST, 10); // playerPriceValue(데이터 , 강화등급)
    await saveToDB(BOE_RESULTS);
    const BOE_FINAL = SortAndSlice(BOE_RESULTS, 100); // SortAndSlice(데이터 , 자르기숫자)

    for (let item of BOE_FINAL) {
      const playerDocs = await Price.find({ id: item.id });
      if (playerDocs.length > 0 && playerDocs[0]._id) {
        const playerData = {
          grade: item.prices.grade,
          playerPrice: playerDocs[0]?._id || null,
        };
        BOE21_TOP_100.playerPrice.push(playerData);
      }
    }
    data.seasonPack.push({ ...BOE21_TOP_100 });
    // -------------------------------------- MC_TOP_70--------------------------------------

    const MC_LIST = await playerSearch([237], 90); // playerSearch(시즌넘버, 최소오버롤)
    let MC_RESULTS = await playerPriceValue(MC_LIST, 10); // playerPriceValue(데이터 , 강화등급)
    await saveToDB(MC_RESULTS);
    const MC_FINAL = SortAndSlice(MC_RESULTS, 70); // SortAndSlice(데이터 , 자르기숫자)

    for (let item of MC_FINAL) {
      const playerDocs = await Price.find({ id: item.id });
      if (playerDocs.length > 0 && playerDocs[0]._id) {
        const playerData = {
          grade: item.prices.grade,
          playerPrice: playerDocs[0]?._id || null,
        };
        MC_TOP_70.playerPrice.push(playerData);
      }
    }
    data.seasonPack.push({ ...MC_TOP_70 });
    // -------------------------------------- LN_TOP_85--------------------------------------

    const LN_LIST = await playerSearch([268], 103); // playerSearch(시즌넘버, 최소오버롤)
    let LN_RESULTS = await playerPriceValue(LN_LIST, 9); // playerPriceValue(데이터 , 강화등급)
    await saveToDB(LN_RESULTS);
    const LN_FINAL = SortAndSlice(LN_RESULTS, 85); // SortAndSlice(데이터 , 자르기숫자)

    for (let item of LN_FINAL) {
      const playerDocs = await Price.find({ id: item.id });
      if (playerDocs.length > 0 && playerDocs[0]._id) {
        const playerData = {
          grade: item.prices.grade,
          playerPrice: playerDocs[0]?._id || null,
        };
        LN_TOP_85.playerPrice.push(playerData);
      }
    }
    data.seasonPack.push({ ...LN_TOP_85 });
    // -------------------------------------- HG_TOP_90--------------------------------------

    const HG_LIST = await playerSearch([283], 103); // playerSearch(시즌넘버, 최소오버롤)
    let HG_RESULTS = await playerPriceValue(HG_LIST, 9); // playerPriceValue(데이터 , 강화등급)
    await saveToDB(HG_RESULTS);
    const HG_FINAL = SortAndSlice(HG_RESULTS, 90); // SortAndSlice(데이터 , 자르기숫자)

    for (let item of HG_FINAL) {
      const playerDocs = await Price.find({ id: item.id });
      if (playerDocs.length > 0 && playerDocs[0]._id) {
        const playerData = {
          grade: item.prices.grade,
          playerPrice: playerDocs[0]?._id || null,
        };
        HG_TOP_90.playerPrice.push(playerData);
      }
    }
    data.seasonPack.push({ ...HG_TOP_90 });
    // -------------------------------------- RTN_TOP_65--------------------------------------

    const RTN_LIST = await playerSearch([284], 99); // playerSearch(시즌넘버, 최소오버롤)
    let RTN_RESULTS = await playerPriceValue(RTN_LIST, 9); // playerPriceValue(데이터 , 강화등급)
    await saveToDB(RTN_RESULTS);
    const RTN_FINAL = SortAndSlice(RTN_RESULTS, 65); // SortAndSlice(데이터 , 자르기숫자)

    for (let item of RTN_FINAL) {
      const playerDocs = await Price.find({ id: item.id });
      if (playerDocs.length > 0 && playerDocs[0]._id) {
        const playerData = {
          grade: item.prices.grade,
          playerPrice: playerDocs[0]?._id || null,
        };
        RTN_TOP_65.playerPrice.push(playerData);
      }
    }
    data.seasonPack.push({ ...RTN_TOP_65 });
    // -------------------------------------- LOL_FA_TOP_50--------------------------------------

    const LOL_FA_LIST = await playerSearch([265, 264], 103); // playerSearch(시즌넘버, 최소오버롤)
    let LOL_FA_RESULTS = await playerPriceValue(LOL_FA_LIST, 9); // playerPriceValue(데이터 , 강화등급)
    await saveToDB(LOL_FA_RESULTS);
    const LOL_FA_FINAL = SortAndSlice(LOL_FA_RESULTS, 50); // SortAndSlice(데이터 , 자르기숫자)

    for (let item of LOL_FA_FINAL) {
      const playerDocs = await Price.find({ id: item.id });
      if (playerDocs.length > 0 && playerDocs[0]._id) {
        const playerData = {
          grade: item.prices.grade,
          playerPrice: playerDocs[0]?._id || null,
        };
        LOL_FA_TOP_50.playerPrice.push(playerData);
      }
    }
    data.seasonPack.push({ ...LOL_FA_TOP_50 });
    // -------------------------------------- HR22_TOP_110--------------------------------------

    const HR22_LIST = await playerSearch([261, 256, 254, 251, 247, 294], 103); // playerSearch(시즌넘버, 최소오버롤)
    let HR22_RESULTS = await playerPriceValue(HR22_LIST, 9); // playerPriceValue(데이터 , 강화등급)
    await saveToDB(HR22_RESULTS);
    const HR22_FINAL = SortAndSlice(HR22_RESULTS, 110); // SortAndSlice(데이터 , 자르기숫자)

    for (let item of HR22_FINAL) {
      const playerDocs = await Price.find({ id: item.id });
      if (playerDocs.length > 0 && playerDocs[0]._id) {
        const playerData = {
          grade: item.prices.grade,
          playerPrice: playerDocs[0]?._id || null,
        };
        HR22_TOP_110.playerPrice.push(playerData);
      }
    }
    data.seasonPack.push({ ...HR22_TOP_110 });
    // -------------------------------------- COC_OTW_TOP_50--------------------------------------

    const COC_OTW_LIST = await playerSearch([217, 218, 210, 207, 206, 201], 75); // playerSearch(시즌넘버, 최소오버롤)
    let COC_OTW_RESULTS = await playerPriceValue(COC_OTW_LIST, 10); // playerPriceValue(데이터 , 강화등급)
    await saveToDB(COC_OTW_RESULTS);
    const COC_OTW_FINAL = SortAndSlice(COC_OTW_RESULTS, 50); // SortAndSlice(데이터 , 자르기숫자)

    for (let item of COC_OTW_FINAL) {
      const playerDocs = await Price.find({ id: item.id });
      if (playerDocs.length > 0 && playerDocs[0]._id) {
        const playerData = {
          grade: item.prices.grade,
          playerPrice: playerDocs[0]?._id || null,
        };
        COC_OTW_TOP_50.playerPrice.push(playerData);
      }
    }
    data.seasonPack.push({ ...COC_OTW_TOP_50 });

    // -------------------------------------------------------------------------------------------------------------------------------

    const doc = await EventValueChart.findOne({
      id: "챔피언스 저니 4000p",
    }).lean();

    let mergedSeasonPacks = [];
    const now = new Date();
    const koreaTime = new Date(now.getTime() + 9 * 60 * 60 * 1000);

    if (doc) {
      const existingSeasonPacks = doc.seasonPack;

      mergedSeasonPacks = [...existingSeasonPacks];

      for (const incoming of data.seasonPack) {
        const index = mergedSeasonPacks.findIndex(
          (pack) => pack.packName === incoming.packName
        );

        if (index > -1) {
          mergedSeasonPacks[index] = {
            ...mergedSeasonPacks[index],
            ...incoming,
          };
        } else {
          mergedSeasonPacks.push(incoming);
        }
      }
    } else {
      mergedSeasonPacks = data.seasonPack;
    }

    // 🔧 에러 방지를 위한 toObject 처리
    const finalSeasonPack = mergedSeasonPacks.map((pack) =>
      typeof pack.toObject === "function" ? pack.toObject() : pack
    );

    console.log("finalSeasonPack:", finalSeasonPack);

    await EventValueChart.updateOne(
      { id: "챔피언스 저니 4000p" },
      {
        $set: {
          updateTime: koreaTime,
          seasonPack: finalSeasonPack,
        },
      },
      { upsert: true }
    );

    console.log("✅ Crawling process completed.");
    process.exit(0);
  } catch (error) {
    console.error("❌ Error in crawler:", error.message);
    process.exit(1);
  }
}

main();
