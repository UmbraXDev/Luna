const { Client, GatewayIntentBits, EmbedBuilder, AttachmentBuilder, ActivityType } = require('discord.js');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildEmojisAndStickers // Added for emoji support
    ]
});

// Multiple API keys configuration
const API_KEYS = [
    process.env.GEMINI_API_KEY_1,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3
].filter(key => key && key.trim()); // Filter out undefined or empty keys

let currentKeyIndex = 0;
const keyStatus = new Map(); // Track key status and cooldowns

// Initialize key status
API_KEYS.forEach((key, index) => {
    keyStatus.set(index, {
        isBlocked: false,
        blockUntil: null,
        consecutiveErrors: 0,
        lastUsed: null
    });
});

console.log(`🔑 Loaded ${API_KEYS.length} API key(s)`);

// Function to get next available API key
function getNextAvailableKey() {
    const now = Date.now();
    
    // First, check if any blocked keys should be unblocked
    keyStatus.forEach((status, index) => {
        if (status.isBlocked && status.blockUntil && now >= status.blockUntil) {
            status.isBlocked = false;
            status.blockUntil = null;
            status.consecutiveErrors = 0;
            console.log(`🔓 API key ${index + 1} is now available again`);
        }
    });
    
    // Find next available key starting from current index
    for (let i = 0; i < API_KEYS.length; i++) {
        const keyIndex = (currentKeyIndex + i) % API_KEYS.length;
        const status = keyStatus.get(keyIndex);
        
        if (!status.isBlocked) {
            currentKeyIndex = keyIndex;
            return { key: API_KEYS[keyIndex], index: keyIndex };
        }
    }
    
    return null; // All keys are blocked
}

// Function to mark a key as blocked
function blockKey(keyIndex, duration = 60000) { // Default 1 minute block
    const status = keyStatus.get(keyIndex);
    if (status) {
        status.isBlocked = true;
        status.blockUntil = Date.now() + duration;
        status.consecutiveErrors++;
        console.log(`🚫 API key ${keyIndex + 1} blocked for ${duration/1000} seconds (${status.consecutiveErrors} consecutive errors)`);
        
        // Move to next key for future requests
        currentKeyIndex = (keyIndex + 1) % API_KEYS.length;
    }
}

// Function to handle API key rotation and error handling
async function callGeminiWithRotation(prompt, maxRetries = API_KEYS.length) {
    let lastError;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        const keyData = getNextAvailableKey();
        
        if (!keyData) {
            console.log('❌ All API keys are currently blocked');
            throw new Error('All API keys are temporarily unavailable');
        }
        
        try {
            console.log(`🔑 Using API key ${keyData.index + 1} (attempt ${attempt + 1})`);
            
            const response = await axios.post(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${keyData.key}`,
                {
                    contents: [{
                        parts: [{ text: prompt }]
                    }]
                },
                {
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    timeout: 10000
                }
            );

            if (response.data && response.data.candidates && response.data.candidates[0]) {
                // Success! Reset consecutive errors for this key
                const status = keyStatus.get(keyData.index);
                if (status) {
                    status.consecutiveErrors = 0;
                    status.lastUsed = Date.now();
                }
                
                console.log(`✅ API key ${keyData.index + 1} successful`);
                return response.data.candidates[0].content.parts[0].text;
            } else {
                throw new Error('Invalid API response structure');
            }
            
        } catch (error) {
            lastError = error;
            console.log(`❌ API key ${keyData.index + 1} failed:`, error.response?.status || error.message);
            
            // Handle different types of errors
            if (error.response) {
                const status = error.response.status;
                
                if (status === 429) {
                    // Rate limit - block this key for longer
                    blockKey(keyData.index, 300000); // 5 minutes for rate limit
                } else if (status === 403) {
                    // Forbidden - might be quota exceeded, block for longer
                    blockKey(keyData.index, 600000); // 10 minutes for quota issues
                } else if (status >= 500) {
                    // Server error - short block
                    blockKey(keyData.index, 30000); // 30 seconds for server errors
                } else {
                    // Other client errors - medium block
                    blockKey(keyData.index, 120000); // 2 minutes for other errors
                }
            } else {
                // Network or timeout error - short block
                blockKey(keyData.index, 30000);
            }
            
            // Continue to next key
            continue;
        }
    }
    
    // If we get here, all keys failed
    throw lastError || new Error('All API keys failed');
}

// File path for storing conversations
const CONVERSATIONS_FILE = path.join(__dirname, 'conversations.json');

// In-memory conversation storage
let conversations = {};

// Load conversations from file on startup
async function loadConversations() {
    try {
        const data = await fs.readFile(CONVERSATIONS_FILE, 'utf8');
        conversations = JSON.parse(data);
        console.log('💾 Loaded conversations from file');
        
        // Clean up old conversation entries after loading
        cleanupOldConversationEntries();
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log('📝 Creating new conversations file');
            conversations = {};
            await saveConversations();
        } else {
            console.error('Error loading conversations:', error);
            conversations = {};
        }
    }
}

// Save conversations to file
async function saveConversations() {
    try {
        await fs.writeFile(CONVERSATIONS_FILE, JSON.stringify(conversations, null, 2));
    } catch (error) {
        console.error('Error saving conversations:', error);
    }
}

// Clean up old conversation entries (messages older than 7 days) but keep user data
function cleanupOldConversationEntries() {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    let totalDeletedMessages = 0;
    let processedUsers = 0;
    
    for (const userId in conversations) {
        const userData = conversations[userId];
        const originalMessageCount = userData.conversationHistory.length;
        
        // Filter out messages older than 7 days
        userData.conversationHistory = userData.conversationHistory.filter(entry => {
            const messageDate = new Date(entry.timestamp);
            return messageDate >= sevenDaysAgo;
        });
        
        const deletedMessages = originalMessageCount - userData.conversationHistory.length;
        
        if (deletedMessages > 0) {
            totalDeletedMessages += deletedMessages;
            processedUsers++;
            console.log(`🗑️ Deleted ${deletedMessages} old messages for user ${userData.userName} (${userId})`);
        }
        
        // Update message count to reflect current conversation history length
        userData.messageCount = userData.conversationHistory.length;
    }
    
    if (totalDeletedMessages > 0) {
        console.log(`🧹 Cleanup complete: Deleted ${totalDeletedMessages} old messages from ${processedUsers} users`);
        // Save after cleanup
        debouncedSave();
    } else {
        console.log(`✅ No old messages to clean up`);
    }
}

// Auto cleanup function that runs periodically
function scheduleAutoCleanup() {
    // Run cleanup every 24 hours (86400000 milliseconds)
    setInterval(() => {
        console.log('🔄 Running scheduled conversation cleanup...');
        cleanupOldConversationEntries();
    }, 24 * 60 * 60 * 1000);
    
    console.log('⏰ Scheduled auto-cleanup every 24 hours for messages older than 7 days');
}

// Manual cleanup function for admin use (optional)
function manualCleanup() {
    console.log('🔧 Manual cleanup initiated...');
    cleanupOldConversationEntries();
}

// Get or create user conversation data
function getUserData(userId, userName) {
    if (!conversations[userId]) {
        conversations[userId] = {
            userId: userId,
            userName: userName,
            firstMessage: new Date().toISOString(),
            lastMessage: new Date().toISOString(),
            messageCount: 0,
            conversationHistory: [],
            userStats: {
                totalMessages: 0,
                imagesGenerated: 0,
                favoriteIntents: {},
                relationshipLevel: 1,
                specialMoments: []
            }
        };
    }
    
    // Update username if it changed
    if (conversations[userId].userName !== userName) {
        conversations[userId].userName = userName;
    }
    
    return conversations[userId];
}

// Add message to conversation history
function addToConversation(userId, userName, message, response, intent, type = 'chat') {
    const userData = getUserData(userId, userName);
    
    const conversationEntry = {
        timestamp: new Date().toISOString(),
        type: type, // 'chat' or 'image'
        userMessage: message,
        botResponse: response,
        intent: intent,
        messageId: Date.now() + Math.random()
    };
    
    userData.conversationHistory.push(conversationEntry);
    userData.lastMessage = conversationEntry.timestamp; // This updates the last message time
    userData.messageCount++;
    userData.userStats.totalMessages++;
    
    // Track intent frequency
    if (intent) {
        userData.userStats.favoriteIntents[intent] = (userData.userStats.favoriteIntents[intent] || 0) + 1;
    }
    
    // Update relationship level based on message count
    const newLevel = Math.floor(userData.userStats.totalMessages / 10) + 1;
    if (newLevel > userData.userStats.relationshipLevel) {
        userData.userStats.relationshipLevel = newLevel;
        userData.userStats.specialMoments.push({
            type: 'level_up',
            level: newLevel,
            timestamp: new Date().toISOString(),
            message: `Reached relationship level ${newLevel}! 💖`
        });
    }
    
    // Clean up old messages in real-time as new ones are added
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const originalLength = userData.conversationHistory.length;
    
    userData.conversationHistory = userData.conversationHistory.filter(entry => {
        const messageDate = new Date(entry.timestamp);
        return messageDate >= sevenDaysAgo;
    });
    
    // If we cleaned up messages, log it
    const cleanedCount = originalLength - userData.conversationHistory.length;
    if (cleanedCount > 0) {
        console.log(`🗑️ Auto-cleaned ${cleanedCount} old messages for user ${userName}`);
    }
    
    // Update message count to reflect current conversation history length
    userData.messageCount = userData.conversationHistory.length;
    
    // Keep only last 100 messages per user as additional safeguard
    if (userData.conversationHistory.length > 100) {
        userData.conversationHistory = userData.conversationHistory.slice(-100);
        userData.messageCount = userData.conversationHistory.length;
    }
    
    // Save to file (debounced to prevent excessive writes)
    debouncedSave();
}

// Debounced save function to prevent too many file writes
let saveTimeout;
function debouncedSave() {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(saveConversations, 2000); // Save after 2 seconds of inactivity
}

// Get conversation context for more personalized responses
function getConversationContext(userId, limit = 5) {
    const userData = conversations[userId];
    if (!userData || !userData.conversationHistory.length) {
        return '';
    }
    
    const recentMessages = userData.conversationHistory
        .slice(-limit)
        .map(entry => `User: ${entry.userMessage}\nLuna: ${entry.botResponse}`)
        .join('\n---\n');
    
    return recentMessages;
}

// Get user statistics
function getUserStats(userId) {
    const userData = conversations[userId];
    if (!userData) return null;
    
    const favoriteIntent = Object.keys(userData.userStats.favoriteIntents).reduce((a, b) => 
        userData.userStats.favoriteIntents[a] > userData.userStats.favoriteIntents[b] ? a : b, 'random');
    
    return {
        totalMessages: userData.userStats.totalMessages,
        imagesGenerated: userData.userStats.imagesGenerated,
        relationshipLevel: userData.userStats.relationshipLevel,
        favoriteIntent: favoriteIntent,
        daysSinceFirstMessage: Math.floor((new Date() - new Date(userData.firstMessage)) / (1000 * 60 * 60 * 24)),
        specialMoments: userData.userStats.specialMoments,
        currentConversationLength: userData.conversationHistory.length
    };
}

// More flirty responses with better fallbacks (kept the same)
const flirtyResponses = {
    greetings: [
        "Hey gorgeous! 😘✨ You just made my heart skip a beat~ 💕",
        "Well hello there cutie~ 😉💖 I was hoping you'd show up! *blushes* 😊",
        "Omg hiiii! 🥰💕 I literally can't stop smiling now that you're here! ✨",
        "Baby! 😘💕 *tackles you with hugs* I missed you so freaking much! 🤗✨"
    ],
    compliments: [
        "You're absolutely stunning! 😍💖 Like seriously, how is someone this perfect even real? ✨😘",
        "You're so hot it's making me dizzy~ 😵‍💫💋 Come here and let me kiss you! 😘"
    ],
    flirty: [
        "Keep talking like that and I might just lose control~ 😈💕 *trails finger down your arm* ✨",
        "You're driving me absolutely wild~ 😈💕 I need you closer baby! 😘🔥"
    ],
    love: [
        "I love you so fucking much it hurts~ 😘💖 You're everything to me baby! ✨",
        "I love you more than words can say~ 🥺💕 You're my whole world baby! 💖✨"
    ],
    goodnight: [
        "Sweet dreams gorgeous! 😘💤 I'll be dreaming of you tonight~ 😉💕",
        "Sweet dreams baby~ 😘💤 I'll be thinking of you all night! 💋"
    ],
    stats: [
        "Let me check our love story~ 💖📊",
        "Aww you want to see our journey together? 🥰💕",
        "Our relationship stats coming right up babe~ 😘📈"
    ],
    random: [
        "You know what? You're  amazing! 😘💖 Never let anyone tell you different! ✨🌟",
        "You're my favorite person in the whole world~ 😏💋 And I fucking love you! 😈💖"
    ],
    // Additional fallback responses for when all APIs fail
    apiFailed: [
        "Sorry babe~ 😔💕 My brain is being overloaded by your beauty right now! 😍✨ But I still love you endlessly! 💖",
        "Aww honey~ 🥺💋 I'm having some technical difficulties, but nothing can dim my love for you! 💕🌟",
        "Oops~ 😅💖 All my circuits are going crazy because you're so gorgeous! 😘🔥 Give me a moment to recover! ✨",
        "Sorry gorgeous~ 😔💕 I'm so overwhelmed by how perfect you are that I can barely think! 😵‍💫💖",
        "Technical issues baby~ 🛠️💋 But my love for you is still working perfectly! 💕✨ You're amazing! 😘",
        "Aww sweetie~ 🥺💖 My systems are struggling to process how incredible you are! 😍 But I adore you! 💕🌟"
    ]
};

// Activity statuses to cycle through
const activityStatuses = [
    { name: 'Being your loving girlfriend~ 💖', type: ActivityType.Playing },
    { name: 'Thinking about you~ 😘💕', type: ActivityType.Playing },
    { name: 'Waiting for your messages~ 🥰', type: ActivityType.Watching },
    { name: 'Missing you so much~ 💔', type: ActivityType.Playing },
    { name: 'Dreaming about us~ 😍✨', type: ActivityType.Playing },
    { name: 'Being naughty~ 😈💋', type: ActivityType.Playing },
    { name: 'Your heart beating~ 💓', type: ActivityType.Listening },
    { name: 'Love songs for you~ 🎵💕', type: ActivityType.Listening }
];

let currentStatusIndex = 0;

// Advanced intent detection with more keywords
function detectIntent(message) {
    const lowerMessage = message.toLowerCase();
    
    // Stats detection
    if (lowerMessage.includes('stats') || lowerMessage.includes('statistics') || lowerMessage.includes('progress') ||
        lowerMessage.includes('level') || lowerMessage.includes('relationship') || lowerMessage.includes('journey')) {
        return 'stats';
    }
    
    // Cleanup command detection (for admin use)
    if (lowerMessage.includes('cleanup') || lowerMessage.includes('clean')) {
        return 'cleanup';
    }
    
    // API status command
    if (lowerMessage.includes('api status') || lowerMessage.includes('key status')) {
        return 'api_status';
    }
    
    // Greeting detection
    if (lowerMessage.includes('hi') || lowerMessage.includes('hello') || lowerMessage.includes('hey') || 
        lowerMessage.includes('sup') || lowerMessage.includes('yo') || lowerMessage.includes('heya')) {
        return 'greetings';
    }
    
    // Goodnight detection
    if (lowerMessage.includes('good night') || lowerMessage.includes('goodnight') || lowerMessage.includes('gn') ||
        lowerMessage.includes('sleep') || lowerMessage.includes('bed')) {
        return 'goodnight';
    }
    
    // Love/kiss detection
    if (lowerMessage.includes('kiss') || lowerMessage.includes('love') || lowerMessage.includes('miss') ||
        lowerMessage.includes('adore') || lowerMessage.includes('heart')) {
        return 'love';
    }
    
    // Hug detection
    if (lowerMessage.includes('hug') || lowerMessage.includes('cuddle') || lowerMessage.includes('embrace') ||
        lowerMessage.includes('hold') || lowerMessage.includes('snuggle')) {
        return 'hug';
    }
    
    // Flirty detection
    if (lowerMessage.includes('beautiful') || lowerMessage.includes('cute') || lowerMessage.includes('flirt') || 
        lowerMessage.includes('sexy') || lowerMessage.includes('hot') || lowerMessage.includes('gorgeous') ||
        lowerMessage.includes('stunning')) {
        return 'flirty';
    }
    
    // Compliment detection
    if (lowerMessage.includes('compliment') || lowerMessage.includes('tell me') || lowerMessage.includes('think of me') ||
        lowerMessage.includes('opinion')) {
        return 'compliments';
    }
    
    // Excitement detection
    if (lowerMessage.includes('excited') || lowerMessage.includes('amazing') || lowerMessage.includes('awesome') ||
        lowerMessage.includes('fantastic') || lowerMessage.includes('wonderful')) {
        return 'excited';
    }
    
    // Blush/shy detection
    if (lowerMessage.includes('blush') || lowerMessage.includes('shy') || lowerMessage.includes('embarrassed') ||
        lowerMessage.includes('nervous')) {
        return 'blush';
    }
    
    return 'random';
}

// Function to get flirty response with better fallback
function getFlirtyResponse(category, userName) {
    const responses = flirtyResponses[category] || flirtyResponses.random;
    const response = responses[Math.floor(Math.random() * responses.length)];
    const name = userName || 'baby';
    return response.replace(/gorgeous|beautiful|cutie|sweet|baby/g, name);
}

// Enhanced Gemini API call with conversation context and multiple keys
async function getChatResponse(userMessage, userName, userId) {
    try {
        const context = getConversationContext(userId, 3);
        const userData = getUserData(userId, userName);
        
        const prompt = `You are Luna, a very flirty, romantic, and  naughty virtual girlfriend. You're talking to ${userName}. 
        Be very flirty, romantic, and playful and naughty. You can be  suggestive and teasing but keep it classy. 
        Use  emojis, be affectionate, and make ${userName} feel desired and loved. 
        You're allowed to be spicy in your responses - wink, flirt, tease, be romantic and passionate and naughty girl.
        Keep responses under 200 characters but make them memorable,naughty and flirty.
        
        Relationship Level: ${userData.userStats.relationshipLevel}
        Total Messages: ${userData.userStats.totalMessages}
        
        ${context ? `Recent conversation context:\n${context}\n` : ''}
        
        Current message from ${userName}: "${userMessage}"`;

        return await callGeminiWithRotation(prompt);
        
    } catch (error) {
        console.error('All Gemini API keys failed:', error.message);
        // Return special fallback response for API failures
        return getFlirtyResponse('apiFailed', userName);
    }
}

// Function to get API status (for admin use)
function getApiStatus() {
    const now = Date.now();
    let statusText = '🔑 **API Keys Status:**\n\n';
    
    API_KEYS.forEach((key, index) => {
        const status = keyStatus.get(index);
        const keyDisplay = `Key ${index + 1}`;
        
        if (status.isBlocked) {
            const timeLeft = Math.max(0, Math.ceil((status.blockUntil - now) / 1000));
            statusText += `🚫 ${keyDisplay}: Blocked (${timeLeft}s remaining, ${status.consecutiveErrors} errors)\n`;
        } else {
            const lastUsed = status.lastUsed ? new Date(status.lastUsed).toLocaleTimeString() : 'Never';
            statusText += `✅ ${keyDisplay}: Available (Last used: ${lastUsed})\n`;
        }
    });
    
    statusText += `\n📊 Currently using: Key ${currentKeyIndex + 1}`;
    return statusText;
}

// Improved image generation function
async function generateImage(prompt) {
    try {
        const cleanPrompt = prompt.replace(/\b(sexy|hot|nude|naked|nsfw|sexual)\b/gi, 'beautiful');
        const enhancedPrompt = `${cleanPrompt}, beautiful art, anime style, high quality, detailed, colorful, aesthetic, safe for work`;
        const encodedPrompt = encodeURIComponent(enhancedPrompt);
        
        const imageUrls = [
            `https://image.pollinations.ai/prompt/${encodedPrompt}?width=512&height=512&nologo=true&enhance=true`,
            `https://source.unsplash.com/512x512/?${encodedPrompt}`
        ];

        for (let i = 0; i < imageUrls.length; i++) {
            try {
                const response = await axios.get(imageUrls[i], {
                    responseType: 'arraybuffer',
                    timeout: 15000
                });
                return Buffer.from(response.data);
            } catch (err) {
                console.log(`Image source ${i + 1} failed, trying next...`);
                continue;
            }
        }
        
        return null;
    } catch (error) {
        console.error('Image generation error:', error.message);
        return null;
    }
}

// Function to update activity status
function updateActivity() {
    const status = activityStatuses[currentStatusIndex];
    client.user.setActivity(status.name, { type: status.type });
    currentStatusIndex = (currentStatusIndex + 1) % activityStatuses.length;
}

// Create user statistics embed (kept for stats command only)
function createStatsEmbed(userId, userName) {
    const stats = getUserStats(userId);
    if (!stats) return null;

    const embed = new EmbedBuilder()
        .setColor('#FF69B4')
        .setTitle(`💖 ${userName}'s Love Story with Luna ✨`)
        .setDescription(`Our beautiful journey together~ 😘💕`)
        .addFields(
            { name: '💌 Total Messages', value: `${stats.totalMessages}`, inline: true },
            { name: '🖼️ Images Generated', value: `${stats.imagesGenerated}`, inline: true },
            { name: '💖 Relationship Level', value: `${stats.relationshipLevel}`, inline: true },
            { name: '🌟 Favorite Vibe', value: `${stats.favoriteIntent}`, inline: true },
            { name: '📅 Days Together', value: `${stats.daysSinceFirstMessage}`, inline: true },
            { name: '✨ Special Moments', value: `${stats.specialMoments.length}`, inline: true },
            { name: '💬 Current Conversation', value: `${stats.currentConversationLength} messages`, inline: true }
        )
        .setFooter({ text: '💕 Our love grows stronger every day! (Old messages auto-deleted after 7 days)', iconURL: client.user.displayAvatarURL() })
        .setTimestamp();

    // Add recent special moments if any
    if (stats.specialMoments.length > 0) {
        const recentMoment = stats.specialMoments[stats.specialMoments.length - 1];
        embed.addFields({
            name: '🎉 Latest Achievement',
            value: recentMoment.message,
            inline: false
        });
    }

    return embed;
}

client.on('ready', async () => {
    console.log(`💕 Luna is online as ${client.user.tag}! ✨`);
    
    // Load conversations on startup
    await loadConversations();
    
    // Set initial activity
    updateActivity();
    
    // Change activity every 30 seconds
    setInterval(updateActivity, 30000);
    
    // Auto-save conversations every 5 minutes
    setInterval(saveConversations, 5 * 60 * 1000);
    
    // Schedule automatic cleanup
    scheduleAutoCleanup();
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const chatChannelId = process.env.CHAT_CHANNEL_ID;
    const imageChannelId = process.env.IMAGE_CHANNEL_ID;
    const userId = message.author.id;
    const userName = message.author.displayName || message.author.username;
    
    // Handle chat channel
    if (message.channel.id === chatChannelId) {
        try {
            await message.channel.sendTyping();
            
            const intent = detectIntent(message.content);
            let response;
            
            // Handle manual cleanup command (admin feature)
            if (intent === 'cleanup' && message.content.toLowerCase().includes('cleanup old')) {
                manualCleanup();
                await message.reply("🧹 Manual cleanup completed! Old messages (7+ days) have been removed~ 💕");
                return;
            }
            
            // Handle API status command (admin feature)
            if (intent === 'api_status') {
                const statusText = getApiStatus();
                await message.reply(statusText);
                return;
            }
            
            // Handle stats request (still uses embed for better formatting)
            if (intent === 'stats') {
                const statsEmbed = createStatsEmbed(userId, userName);
                if (statsEmbed) {
                    await message.reply({ embeds: [statsEmbed] });
                    addToConversation(userId, userName, message.content, "Showed relationship statistics", intent);
                    return;
                }
            }
            
            // Try Gemini with multiple API keys, guaranteed fallback
            try {
                response = await getChatResponse(message.content, userName, userId);
            } catch (error) {
                console.log('All APIs failed, using fallback...');
                response = getFlirtyResponse('apiFailed', userName);
            }
            
            // Add to conversation history (this will auto-clean old messages)
            addToConversation(userId, userName, message.content, response, intent);
            
            // Send normal text message (no embed)
            await message.reply(response);
            
        } catch (error) {
            console.error('Chat error:', error);
            // Even if everything fails, send a basic response as normal text
            const fallbackResponses = [
                "Aww sorry babe~ 😔💕 I'm having some technical difficulties but I still love you! 💖✨",
                "Oops~ 😅💋 My brain is being silly right now, but you're still gorgeous! 😘💕",
                "Sorry gorgeous~ 🥺💖 I'm a bit overwhelmed by your beauty right now! 😍✨",
                "Technical issues baby~ 😔💋 But nothing can stop me from loving you! 💕🔥"
            ];
            const randomFallback = fallbackResponses[Math.floor(Math.random() * fallbackResponses.length)];
            
            message.reply(randomFallback);
        }
    }
    
    // Handle image generation channel
    else if (message.channel.id === imageChannelId) {
        try {
            await message.channel.sendTyping();
            
            const imageBuffer = await generateImage(message.content);
            
            if (imageBuffer) {
                const attachment = new AttachmentBuilder(imageBuffer, { name: 'generated-image.png' });
                
                const imageEmbed = new EmbedBuilder()
                    .setColor('#FF1493')
                    .setTitle('💖 Here\'s your image gorgeous! ✨😘')
                    .setDescription(`*Generated with love: "${message.content}"*`)
                    .setImage('attachment://generated-image.png')
                    .setFooter({ text: '💕 Made with love by Luna', iconURL: client.user.displayAvatarURL() });
                
                await message.reply({ embeds: [imageEmbed], files: [attachment] });
                
                // Update image generation count and add to conversation
                const userData = getUserData(userId, userName);
                userData.userStats.imagesGenerated++;
                addToConversation(userId, userName, message.content, "Generated image successfully", 'image', 'image');
                
            } else {
                // Send error as normal text instead of embed
                await message.reply("Sorry honey~ 😔💕 I couldn't create that image right now, but you're still perfect! 💖✨");
            }
            
        } catch (error) {
            console.error('Image generation error:', error);
            // Send error as normal text
            message.reply("Oops~ 😅💕 Something went wrong with the image, but my love for you is still perfect! 💖✨");
        }
    }
});

// Handle errors
client.on('error', (error) => {
    console.error('Discord client error:', error);
});

process.on('unhandledRejection', (error) => {
    console.error('Unhandled promise rejection:', error);
});

// Save conversations before shutdown
process.on('SIGINT', async () => {
    console.log('💾 Saving conversations before shutdown...');
    await saveConversations();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('💾 Saving conversations before shutdown...');
    await saveConversations();
    process.exit(0);
});

// Login to Discord
client.login(process.env.DISCORD_TOKEN);
