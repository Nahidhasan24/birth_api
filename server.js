const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const bodyParser = require('body-parser');
const cheerio = require('cheerio'); // For parsing HTML
const { v4: uuidv4 } = require('uuid'); // For generating unique session IDs

// Use the stealth plugin to avoid detection
puppeteer.use(StealthPlugin());

const app = express();
const PORT = 3000;

// Session store to track browser and page instances
const sessions = {};

app.use(express.json()); // Parse JSON request bodies

// Function to initialize the browser and page for a new session
const initializeBrowser = async () => {
  const browser = await puppeteer.launch({
    headless: true, // Ensure this is set to true to prevent the browser from popping up
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--ignore-certificate-errors',
      '--disable-dev-shm-usage',
      '--disable-gpu', // Disable GPU acceleration
      '--disable-extensions', // Disable extensions for faster load
      '--single-process', // Use single process
      '--no-zygote', // Disable zygote processes
      '--no-first-run', // Skip first-run tasks
    ],
  });
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4606.61 Safari/537.36',
  });
  return { browser, page };
};


// Function to retry loading the CAPTCHA page
const loadPageWithRetry = async (page, url, retries = 3) => {
  for (let i = 0; i < retries; i++) {
    try {
      console.log(`Loading page, attempt ${i + 1}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      console.log('Page loaded successfully');
      return;
    } catch (error) {
      console.error(`Retrying... Attempt ${i + 1}`);
      if (i === retries - 1) {
        throw error;
      }
    }
  }
};

// Endpoint to get CAPTCHA as base64 and create a session
app.post('/captcha', async (req, res) => {
  try {
    const { browser, page } = await initializeBrowser(); // Create a new session
    await loadPageWithRetry(page, 'https://everify.bdris.gov.bd/');

    await page.waitForSelector('img#CaptchaImage', { timeout: 60000 });
    const captchaElement = await page.$('img#CaptchaImage');

    // Capture CAPTCHA image as base64
    const captchaBase64 = await captchaElement.screenshot({ encoding: 'base64' });

    // Generate a unique session ID
    const sessionId = uuidv4();
    // Store the browser and page in the session store
    sessions[sessionId] = { browser, page };

    // Send the captcha image as a base64 string along with the session ID
    res.json({ captcha: captchaBase64, sessionId });
  } catch (error) {
    console.error('Error loading CAPTCHA:', error);
    res.status(500).json({ message: 'Failed to load CAPTCHA' });
  }
});

// Endpoint to handle form submission and verify the inputs
app.post('/verify', async (req, res) => {
  const { sessionId, birthNumber, birthDate, captchaInput } = req.body;

  // Ensure the session exists
  const session = sessions[sessionId];
  if (!session || !session.browser || !session.page) {
    return res.status(500).json({ message: 'Invalid or expired session. Please request a new CAPTCHA.' });
  }

  const { browser, page } = session;

  try {
    // Use the page from the session (no page reload to avoid changing CAPTCHA)
    await page.waitForSelector('#ubrn');
    await page.waitForSelector('#BirthDate');
    await page.waitForSelector('#CaptchaInputText');

    // Fill in the form
    await page.type('#ubrn', birthNumber);
    await page.type('#BirthDate', birthDate);
    await page.type('#CaptchaInputText', captchaInput);

    // Submit the form by evaluating it via JavaScript
    await page.evaluate(() => {
      document.querySelector('form').submit(); // Submit the form directly
    });

    // Wait for the result page to load
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 });

    // Capture the result page's content
    const resultContent = await page.content();

    // Parse the result content using Cheerio
    const $ = cheerio.load(resultContent);

    // Extract and log all <td> elements within <tbody class="text-uppercase">
    const tbodyData = [];
    $('tbody.text-uppercase td').each((index, element) => {
      const tdText = $(element).text().trim();
      // console.log(`Index: ${index}, Value: ${tdText}`); // Log the index and value
      tbodyData.push(tdText);
    });

    // Create a custom response structure using static mappings
    const customResponse = {
      registrationDate: tbodyData[4], // "01 October 2024"
      registrationOffice: tbodyData[5], // "MOKAMIA UNION PARISHAD"
      issuanceDate: tbodyData[6], // "01 October 2024"
      dateOfBirth: tbodyData[10], // "01 January 2003"
      birthRegistrationNumber: tbodyData[11], // "20030414771107856"
      sex: tbodyData[12], // "MALE",
      registeredName: {
        bangla: tbodyData[14], // "ইরফাত হোসেন'",
        english: tbodyData[16], // "ERFAT HOSSAIN'"
      },
      placeOfBirth: {
        bangla: tbodyData[19], // "গাজীপুর",
        english: tbodyData[21], // "GAZIPUR"
      },
      mother: {
        name: {
          bangla: tbodyData[23], // "মমতাজ  বেগম",
          english: tbodyData[25], // "MAMATAZ  BEGUM"
        },
        nationality: {
          bangla: tbodyData[27], // "বাংলাদেশী",
          english: tbodyData[29] // "Bangladeshi"
        }
      },
      father: {
        name: {
          bangla: tbodyData[31], // "শাহা এমরান",
          english: tbodyData[33], // "SAHA  AMRAN"
        },
        nationality: {
          bangla: tbodyData[35], // "বাংলাদেশী",
          english: tbodyData[37] // "Bangladeshi"
        }
      }
    };



    // Send the custom response
    res.json({
      message: 'success',
      data: customResponse
    });

    // Close the browser after processing and delete the session
    await browser.close();
    delete sessions[sessionId]; // Clean up the session

  } catch (error) {
    console.error('Error during verification:', error);
    // Close the browser in case of error
    if (browser) await browser.close();
    delete sessions[sessionId]; // Clean up the session
    res.status(500).json({ message: 'Verification failed' });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
