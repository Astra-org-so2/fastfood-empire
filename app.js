// FastFood Empire - Main App Logic

// Configuration
const API_URL = 'https://your-api-server.com/api'; // Замените на ваш API
let tg = window.Telegram?.WebApp;
let currentUser = null;
let userData = null;

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    initializeApp();
});

async function initializeApp() {
    // Telegram WebApp setup
    if (tg) {
        tg.ready();
        tg.expand();
        tg.enableClosingConfirmation();
        
        // Haptic feedback support
        window.vibrate = (style) => {
            if (tg.HapticFeedback) {
                tg.HapticFeedback.impactOccurred(style || 'medium');
            }
        };
    }
    
    // Load user data
    await loadUserData();
    
    // Hide loading screen
    setTimeout(() => {
        document.getElementById('loading-screen').classList.remove('active');
        document.getElementById('main-screen').classList.add('active');
    }, 1500);
    
    // Start income timer
    startIncomeTimer();
}

async function loadUserData() {
    try {
        // Get user ID from Telegram or use test user
        let userId;
        
        if (tg && tg.initDataUnsafe && tg.initDataUnsafe.user) {
            userId = tg.initDataUnsafe.user.id;
            currentUser = tg.initDataUnsafe.user;
        } else {
            // Test mode
            userId = 123456789;
            currentUser = { id: userId, first_name: 'Test User' };
        }
        
        // Fetch user data from API
        const response = await fetch(`${API_URL}/user?user_id=${userId}`);
        
        if (!response.ok) {
            throw new Error('Failed to load user data');
        }
        
        const data = await response.json();
        userData = data;
        
        // Update UI
        updateMainScreen();
        
        // Show offline income if any
        if (data.offline_income > 0) {
            showOfflineIncome(data.offline_income);
        }
        
    } catch (error) {
        console.error('Error loading user data:', error);
        // Use mock data for testing
        userData = getMockUserData();
        updateMainScreen();
    }
}

function getMockUserData() {
    return {
        user: {
            user_id: 123456789,
            username: 'TestUser',
            balance: 1000,
            income_per_hour: 50,
            customers_per_hour: 5,
            level: 3,
            prestige_level: 0,
            total_earned: 5000,
            minigames_played: 2
        },
        offline_income: 0,
        upgrades: [
            { upgrade_type: 'grill', level: 2 },
            { upgrade_type: 'fryer', level: 1 }
        ],
        achievements: []
    };
}

function updateMainScreen() {
    const user = userData.user;
    
    // User info
    document.getElementById('user-name').textContent = currentUser.first_name || user.username;
    document.getElementById('user-level').textContent = user.level;
    
    // Prestige badge
    if (user.prestige_level > 0) {
        document.getElementById('prestige-badge').style.display = 'inline';
        document.getElementById('prestige-level').textContent = `⭐${user.prestige_level}`;
    }
    
    // Balance and income
    document.getElementById('balance').textContent = formatMoney(user.balance);
    document.getElementById('income-rate').textContent = `$${formatNumber(user.income_per_hour)}/ч`;
    
    // Stats
    document.getElementById('customers-count').textContent = user.customers_per_hour;
    document.getElementById('total-earned').textContent = formatMoney(user.total_earned);
    
    // Update all balance displays
    updateBalanceDisplays(user.balance);
}

function updateBalanceDisplays(balance) {
    document.getElementById('balance').textContent = formatMoney(balance);
    const balanceUpgrades = document.getElementById('balance-upgrades');
    if (balanceUpgrades) {
        balanceUpgrades.textContent = formatNumber(balance);
    }
}

function formatNumber(num) {
    if (num >= 1_000_000_000) {
        return (num / 1_000_000_000).toFixed(2) + 'B';
    } else if (num >= 1_000_000) {
        return (num / 1_000_000).toFixed(2) + 'M';
    } else if (num >= 1_000) {
        return (num / 1_000).toFixed(2) + 'K';
    }
    return num.toFixed(0);
}

function formatMoney(num) {
    return '$' + formatNumber(num);
}

function showOfflineIncome(amount) {
    const offlineDiv = document.getElementById('offline-income');
    document.getElementById('offline-amount').textContent = formatNumber(amount);
    offlineDiv.style.display = 'block';
    
    // Vibrate
    if (window.vibrate) {
        window.vibrate('heavy');
    }
    
    // Hide after 5 seconds
    setTimeout(() => {
        offlineDiv.style.display = 'none';
    }, 5000);
}

// Income Timer (passive income simulation)
let incomeInterval;

function startIncomeTimer() {
    // Update balance every second (for visual effect)
    incomeInterval = setInterval(() => {
        if (!userData || !userData.user) return;
        
        const incomePerSecond = userData.user.income_per_hour / 3600;
        userData.user.balance += incomePerSecond;
        userData.user.total_earned += incomePerSecond;
        
        updateBalanceDisplays(userData.user.balance);
    }, 1000);
}

// Navigation
function showMain() {
    hideAllScreens();
    document.getElementById('main-screen').classList.add('active');
    updateNavigation('main');
    vibrate('light');
}

function showUpgrades() {
    hideAllScreens();
    document.getElementById('upgrades-screen').classList.add('active');
    updateNavigation('upgrades');
    loadUpgrades();
    vibrate('light');
}

function showGames() {
    hideAllScreens();
    document.getElementById('games-screen').classList.add('active');
    updateNavigation('games');
    loadAchievements();
    vibrate('light');
}

function showLeaderboard() {
    hideAllScreens();
    document.getElementById('leaderboard-screen').classList.add('active');
    updateNavigation('leaderboard');
    loadLeaderboard();
    vibrate('light');
}

function hideAllScreens() {
    document.querySelectorAll('.screen').forEach(screen => {
        screen.classList.remove('active');
    });
}

function updateNavigation(active) {
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    
    const navMap = {
        'main': 0,
        'upgrades': 1,
        'games': 2,
        'leaderboard': 3
    };
    
    const buttons = document.querySelectorAll('.nav-btn');
    if (buttons[navMap[active]]) {
        buttons[navMap[active]].classList.add('active');
    }
}

function vibrate(style = 'medium') {
    if (window.vibrate) {
        window.vibrate(style);
    }
}

// Upgrades
async function loadUpgrades() {
    try {
        const userId = userData.user.user_id;
        const response = await fetch(`${API_URL}/upgrades?user_id=${userId}`);
        
        if (!response.ok) {
            throw new Error('Failed to load upgrades');
        }
        
        const data = await response.json();
        displayUpgrades(data.upgrades);
        
        // Update prestige button
        updatePrestigeButton();
        
    } catch (error) {
        console.error('Error loading upgrades:', error);
        displayUpgrades(getMockUpgrades());
    }
}

function getMockUpgrades() {
    return [
        {
            type: 'grill',
            name: 'Гриль',
            icon: '🔥',
            description: 'Готовьте бургеры быстрее',
            current_level: 2,
            cost: 150,
            can_afford: true,
            income_bonus: 5,
            customer_bonus: 0
        },
        {
            type: 'fryer',
            name: 'Фритюр',
            icon: '🍟',
            description: 'Производство картошки фри',
            current_level: 1,
            cost: 225,
            can_afford: true,
            income_bonus: 4,
            customer_bonus: 0
        }
    ];
}

function displayUpgrades(upgrades) {
    const container = document.getElementById('upgrades-list');
    container.innerHTML = '';
    
    upgrades.forEach(upgrade => {
        const card = createUpgradeCard(upgrade);
        container.appendChild(card);
    });
}

function createUpgradeCard(upgrade) {
    const div = document.createElement('div');
    div.className = 'upgrade-card' + (upgrade.can_afford ? ' can-afford' : '');
    
    div.innerHTML = `
        <div class="upgrade-header">
            <div class="upgrade-title">
                <span class="upgrade-icon">${upgrade.icon}</span>
                <span class="upgrade-name">${upgrade.name}</span>
            </div>
            <div class="upgrade-level">Ур. ${upgrade.current_level}</div>
        </div>
        <div class="upgrade-description">${upgrade.description}</div>
        <div class="upgrade-stats">
            <div class="upgrade-stat">
                <span class="upgrade-stat-label">Доход</span>
                <span class="upgrade-stat-value">+$${upgrade.income_bonus}/ч</span>
            </div>
            ${upgrade.customer_bonus > 0 ? `
            <div class="upgrade-stat">
                <span class="upgrade-stat-label">Посетители</span>
                <span class="upgrade-stat-value">+${upgrade.customer_bonus}/ч</span>
            </div>
            ` : ''}
        </div>
        <button class="upgrade-buy-btn" 
                onclick="buyUpgrade('${upgrade.type}')" 
                ${!upgrade.can_afford ? 'disabled' : ''}>
            ${upgrade.can_afford ? `Улучшить за $${formatNumber(upgrade.cost)}` : `Нужно $${formatNumber(upgrade.cost)}`}
        </button>
    `;
    
    return div;
}

async function buyUpgrade(upgradeType) {
    vibrate('medium');
    
    try {
        const response = await fetch(`${API_URL}/upgrade`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                user_id: userData.user.user_id,
                upgrade_type: upgradeType
            })
        });
        
        const result = await response.json();
        
        if (result.success) {
            vibrate('heavy');
            
            // Update user data
            userData.user = result.user;
            updateMainScreen();
            
            // Reload upgrades
            await loadUpgrades();
            
            // Show success notification
            showNotification(`✅ Улучшение куплено!`, 'success');
        } else {
            showNotification(`❌ ${result.error}`, 'error');
        }
        
    } catch (error) {
        console.error('Error buying upgrade:', error);
        showNotification('❌ Ошибка покупки', 'error');
    }
}

function updatePrestigeButton() {
    const btn = document.getElementById('prestige-btn');
    const user = userData.user;
    
    if (user.level >= 20) {
        btn.disabled = false;
    } else {
        btn.disabled = true;
    }
}

async function performPrestige() {
    if (!confirm('Вы уверены? Это сбросит ваш прогресс, но даст постоянный бонус +10% к доходу!')) {
        return;
    }
    
    vibrate('heavy');
    
    try {
        const response = await fetch(`${API_URL}/prestige`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                user_id: userData.user.user_id
            })
        });
        
        const result = await response.json();
        
        if (result.success) {
            userData.user = result.user;
            updateMainScreen();
            showNotification(`🌟 Престиж ${result.prestige_level}!`, 'success');
            showMain();
        } else {
            showNotification(`❌ ${result.error}`, 'error');
        }
        
    } catch (error) {
        console.error('Error performing prestige:', error);
        showNotification('❌ Ошибка престижа', 'error');
    }
}

// Achievements
async function loadAchievements() {
    const achievements = userData.achievements || [];
    displayAchievements(achievements);
}

function displayAchievements(achievements) {
    const container = document.getElementById('achievements-list');
    container.innerHTML = '';
    
    const defaultAchievements = [
        { id: 'first_dollar', title: '💵 Первый доллар', reward: 100, unlocked: false },
        { id: 'rich', title: '💰 Богач', reward: 1000, unlocked: false },
        { id: 'level_10', title: '🌟 Ветеран', reward: 500, unlocked: false },
        { id: 'prestige_1', title: '⭐ Перерождение', reward: 2000, unlocked: false },
        { id: 'minigames_10', title: '🎮 Геймер', reward: 300, unlocked: false },
        { id: 'all_upgrades', title: '🛠 Максималист', reward: 5000, unlocked: false }
    ];
    
    const achList = achievements.length > 0 ? achievements : defaultAchievements;
    
    achList.forEach(ach => {
        const div = document.createElement('div');
        div.className = 'achievement-card' + (ach.unlocked ? ' unlocked' : '');
        
        div.innerHTML = `
            <div class="achievement-icon">${ach.unlocked ? '🏆' : '🔒'}</div>
            <div class="achievement-title">${ach.title}</div>
            <div class="achievement-reward">+$${formatNumber(ach.reward)}</div>
        `;
        
        container.appendChild(div);
    });
}

// Leaderboard
async function loadLeaderboard() {
    try {
        const response = await fetch(`${API_URL}/leaderboard`);
        const data = await response.json();
        displayLeaderboard(data.leaderboard);
    } catch (error) {
        console.error('Error loading leaderboard:', error);
        displayLeaderboard(getMockLeaderboard());
    }
}

function getMockLeaderboard() {
    return [
        { username: 'Player1', balance: 1000000, income_per_hour: 5000, level: 25, prestige_level: 2 },
        { username: 'Player2', balance: 500000, income_per_hour: 2500, level: 20, prestige_level: 1 },
        { username: 'Player3', balance: 250000, income_per_hour: 1200, level: 15, prestige_level: 0 }
    ];
}

function displayLeaderboard(leaders) {
    const container = document.getElementById('leaderboard-list');
    container.innerHTML = '';
    
    const medals = ['🥇', '🥈', '🥉'];
    
    leaders.forEach((leader, index) => {
        const div = document.createElement('div');
        div.className = 'leaderboard-item' + (index < 3 ? ' top-3' : '');
        
        const rank = index < 3 ? medals[index] : `${index + 1}.`;
        
        div.innerHTML = `
            <div class="rank">${rank}</div>
            <div class="player-info">
                <div class="player-name">${leader.username}</div>
                <div class="player-stats">
                    💰 ${formatMoney(leader.balance)} | 
                    📈 ${formatMoney(leader.income_per_hour)}/ч | 
                    ⭐ Ур.${leader.level}
                    ${leader.prestige_level > 0 ? ` | 🌟 ${leader.prestige_level}` : ''}
                </div>
            </div>
        `;
        
        container.appendChild(div);
    });
}

// Notifications
function showNotification(message, type = 'info') {
    // Create notification element
    const notification = document.createElement('div');
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        left: 50%;
        transform: translateX(-50%);
        background: ${type === 'success' ? '#95E1D3' : '#FF6B6B'};
        color: #1A1A2E;
        padding: 15px 25px;
        border-radius: 15px;
        font-weight: bold;
        z-index: 3000;
        animation: slideDown 0.3s ease;
    `;
    notification.textContent = message;
    
    document.body.appendChild(notification);
    
    setTimeout(() => {
        notification.style.animation = 'fadeOut 0.3s ease';
        setTimeout(() => notification.remove(), 300);
    }, 3000);
}

// Game Modal
function closeGameModal() {
    document.getElementById('game-modal').classList.remove('active');
    vibrate('light');
}

// Export functions for HTML onclick handlers
window.showMain = showMain;
window.showUpgrades = showUpgrades;
window.showGames = showGames;
window.showLeaderboard = showLeaderboard;
window.buyUpgrade = buyUpgrade;
window.performPrestige = performPrestige;
window.closeGameModal = closeGameModal;
