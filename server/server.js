import express from 'express';
import axios from 'axios';
import cors from 'cors';
import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';

// Load environment variables from .env
dotenv.config();

const app = express();
// ✅ Fixed: Use Render's PORT or fallback to 8080 (not 3000)
const PORT = process.env.PORT || 8080;

// Middleware
app.use(cors({
    origin: '*', // Allow all origins for browser extension
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type']
}));
app.use(express.json());

// Environment Variables
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

// Debug: Check if keys are loading
console.log("🔑 GEMINI_API_KEY:", GEMINI_API_KEY ? "Loaded ✅" : "Missing ❌");
console.log("🔑 YOUTUBE_API_KEY:", YOUTUBE_API_KEY ? "Loaded ✅" : "Missing ❌");

if (!GEMINI_API_KEY || !YOUTUBE_API_KEY) {
    console.error('❌ Missing API keys in .env');
    process.exit(1);
}

// ✅ GET route for browser check - Fixed response
app.get('/', (req, res) => {
    res.json({
        status: 'success',
        message: '✅ LeetCode Helper Backend is running',
        endpoints: {
            analyze: 'POST /analyze',
            health: 'GET /'
        },
        timestamp: new Date().toISOString()
    });
});

// ✅ Add health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// 🔍 Get LeetCode Problem Info
async function getLeetCodeProblemInfo(slug) {
    const url = "https://leetcode.com/graphql";
    const query = {
        operationName: "questionData",
        variables: { titleSlug: slug },
        query: `
            query questionData($titleSlug: String!) {
                question(titleSlug: $titleSlug) {
                    questionId
                    title
                    difficulty
                }
            }
        `
    };

    try {
        const response = await axios.post(url, query, {
            headers: {
                "Content-Type": "application/json",
                "Referer": `https://leetcode.com/problems/${slug}/`
            }
        });
        return response.data.data.question;
    } catch (error) {
        throw new Error("LeetCode API error: " + error.message);
    }
}

// 🤖 Gemini Analysis with improved prompt
async function getGeminiAnalysis(title, problemId, difficulty) {
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
   const model = genAI.getGenerativeModel({ model: "gemini-pro" });

    const prompt = `For the LeetCode problem titled: "${title}" (ID: ${problemId}, Difficulty: ${difficulty}):

1. Recommend specific algorithms and data structures to use with complexity analysis
2. Provide progressive hints as an array of strings (NOT objects) - make each hint more specific and actionable
3. Focus on C++ and Java implementations

IMPORTANT: Return ONLY valid JSON in this exact format:
{
    "algorithms": "Your algorithm recommendation as a single string",
    "hints": [
        "First hint as a string",
        "Second hint as a string", 
        "Third hint as a string"
    ]
}

Do NOT include any markdown formatting, code blocks, or additional text outside the JSON.`;

    try {
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = await response.text();

        console.log("🤖 Raw Gemini response:", text);

        // Clean the response to extract JSON
        let cleanedText = text.trim();
        
        // Remove markdown code blocks if present
        cleanedText = cleanedText.replace(/```json\n?/g, '').replace(/```\n?/g, '');
        
        // Find JSON boundaries
        const jsonStart = cleanedText.indexOf('{');
        const jsonEnd = cleanedText.lastIndexOf('}');
        
        if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
            const jsonString = cleanedText.substring(jsonStart, jsonEnd + 1);
            console.log("🔍 Extracted JSON string:", jsonString);
            
            const parsed = JSON.parse(jsonString);
            
            // Validate the structure
            if (!parsed.algorithms || !Array.isArray(parsed.hints)) {
                throw new Error("Invalid response structure from Gemini");
            }
            
            // Ensure all hints are strings
            const processedHints = parsed.hints.map((hint, index) => {
                if (typeof hint === 'object') {
                    // If it's an object, try to extract meaningful text
                    return `Hint ${index + 1}: ${JSON.stringify(hint)}`;
                }
                return String(hint);
            });
            
            return {
                algorithms: String(parsed.algorithms),
                hints: processedHints
            };
        } else {
            throw new Error("No valid JSON found in Gemini response");
        }
    } catch (err) {
        console.error("⚠️ Gemini error:", err.message);
        console.error("⚠️ Full error:", err);
        
        // Return fallback response
        return {
            algorithms: `Error generating analysis for ${title}. Try manual analysis using ${difficulty} level approaches.`,
            hints: [
                "Start by understanding the problem constraints and requirements",
                "Consider the time and space complexity requirements",
                "Think about common patterns for this type of problem"
            ]
        };
    }
}

// 📹 Search YouTube
async function searchYouTubeVideos(query) {
  const url = "https://www.googleapis.com/youtube/v3/search";
  const params = {
    part: 'snippet',
    q: `LeetCode ${query} solution explanation`,
    type: 'video',
    order: 'relevance',
    maxResults: 5,
    key: YOUTUBE_API_KEY
  };

  try {
    const response = await axios.get(url, { params });
    
    // Return full metadata object
    return response.data.items.map(item => ({
      videoId: item.id.videoId,
      title: item.snippet.title,
      channelTitle: item.snippet.channelTitle,
      thumbnail: item.snippet.thumbnails?.medium?.url || "",
      publishedAt: item.snippet.publishedAt
    }));

  } catch (err) {
    console.error("⚠️ YouTube API error:", err.message);
    return [];
  }
}

// 🧠 Main POST route
app.post('/analyze', async (req, res) => {
    const { slug } = req.body;

    if (!slug) {
        return res.status(400).json({ error: "Missing slug parameter" });
    }

    console.log(`🔍 Analyzing problem: ${slug}`);

    try {
        // Get problem info from LeetCode
        const problemInfo = await getLeetCodeProblemInfo(slug);
        
        if (!problemInfo) {
            throw new Error("Problem not found on LeetCode");
        }

        console.log(`📊 Problem info: ${problemInfo.title} (${problemInfo.difficulty})`);

        // Get AI analysis
        const geminiResult = await getGeminiAnalysis(
            problemInfo.title,
            problemInfo.questionId,
            problemInfo.difficulty
        );

        console.log(`🤖 Gemini result:`, geminiResult);

        // Get YouTube videos
        const youtubeLinks = await searchYouTubeVideos(problemInfo.title);

        console.log(`📹 Found ${youtubeLinks.length} YouTube videos`);

        // Prepare response
        const output = {
            title: problemInfo.title,
            problemId: problemInfo.questionId,
            difficulty: problemInfo.difficulty,
            slug: slug,
            algorithms: geminiResult.algorithms,
            hints: geminiResult.hints,
            youtubeLinks: youtubeLinks,
            timestamp: new Date().toISOString() // Add timestamp for cache management
        };

        console.log(`✅ Analysis complete for: ${problemInfo.title}`);
        res.json(output);

    } catch (err) {
        console.error("❌ Error in /analyze:", err.message);
        res.status(500).json({ 
            error: err.message,
            slug: slug,
            timestamp: new Date().toISOString()
        });
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('❌ Unhandled error:', err);
    res.status(500).json({ 
        error: 'Internal server error',
        timestamp: new Date().toISOString()
    });
});

// 404 handler for undefined routes
app.use('*', (req, res) => {
    res.status(404).json({
        error: 'Route not found',
        availableRoutes: ['GET /', 'POST /analyze', 'GET /health'],
        requestedRoute: req.originalUrl
    });
});

// 🚀 Start Server
app.listen(PORT, () => {
    console.log(`🚀 Server is running on port ${PORT}`);
    console.log(`🌐 Render URL: https://leetcode-helper-backend-5xtj.onrender.com`);
    console.log(`📝 Test with: curl -X POST https://leetcode-helper-backend-5xtj.onrender.com/analyze -H "Content-Type: application/json" -d '{"slug":"two-sum"}'`);
});