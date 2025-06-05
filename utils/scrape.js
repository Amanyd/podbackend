const axios = require("axios");
const cheerio = require("cheerio");

async function scrapePage(url) {
  const res = await axios.get(url);
  const $ = cheerio.load(res.data);
  const text = $("body").text();
  return text.replace(/\s+/g, " ").trim();
}

module.exports = { scrapePage };
