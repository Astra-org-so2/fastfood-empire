// FastFood Empire - Mini Games

// Start game
window.startGame = function(gameType) {
    vibrate('medium');
    
    const modal = document.getElementById('game-modal');
    const container = document.getElementById('game-container');
    const title = document.getElementById('game-title');
    
    // Clear container
    container.innerHTML = '';
    
    // Show modal
    modal.classList.add('active');
    
    // Load specific game
    switch(gameType) {
        case 'burger_maker':
            title.textContent = '🍔 Burger Maker';
            initBurgerMaker(container);
            break;
        case 'order_rush':
            title.textContent = '⚡ Order Rush';
            initOrderRush(container);
            break;
        case 'memory_menu':
            title.textContent = '🧠 Memory Menu';
            initMemoryMenu(container);
            break;
    }
};

// Game 1: Burger Maker - собирайте бургеры правильно
function initBurgerMaker(container) {
    let score = 0;
    let timeLeft = 30;
    let currentOrder = [];
    let playerBurger = [];
    
    const ingredients = [
        { name: 'Булка верх', emoji: '🍞', id: 'bun_top' },
        { name: 'Салат', emoji: '🥬', id: 'lettuce' },
        { name: 'Помидор', emoji: '🍅', id: 'tomato' },
        { name: 'Сыр', emoji: '🧀', id: 'cheese' },
        { name: 'Котлета', emoji: '🥩', id: 'patty' },
        { name: 'Булка низ', emoji: '🍔', id: 'bun_bottom' }
    ];
    
    container.innerHTML = `
        <div class="game-board">
            <div class="game-score">
                <div>Счет: <span id="burger-score">0</span></div>
                <div>Время: <span id="burger-time">30</span>с</div>
            </div>
            
            <div style="background: rgba(255,255,255,0.05); padding: 20px; border-radius: 15px; margin-bottom: 20px;">
                <div style="text-align: center; margin-bottom: 10px; font-weight: bold;">Заказ:</div>
                <div id="order-display" style="display: flex; flex-direction: column-reverse; align-items: center; gap: 5px; min-height: 150px;">
                </div>
            </div>
            
            <div style="background: rgba(255,255,255,0.05); padding: 20px; border-radius: 15px; margin-bottom: 20px;">
                <div style="text-align: center; margin-bottom: 10px; font-weight: bold;">Ваш бургер:</div>
                <div id="player-burger" style="display: flex; flex-direction: column-reverse; align-items: center; gap: 5px; min-height: 150px;">
                </div>
            </div>
            
            <div class="game-grid" style="grid-template-columns: repeat(3, 1fr);">
                ${ingredients.map(ing => `
                    <button class="game-btn" onclick="addIngredient('${ing.id}', '${ing.emoji}')">
                        ${ing.emoji} ${ing.name}
                    </button>
                `).join('')}
            </div>
            
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 15px;">
                <button class="game-btn" style="background: linear-gradient(135deg, #FF6B6B, #FF5252);" onclick="checkBurger()">
                    ✅ Готово
                </button>
                <button class="game-btn" style="background: linear-gradient(135deg, #666, #555);" onclick="clearBurger()">
                    🗑 Очистить
                </button>
            </div>
        </div>
    `;
    
    // Generate random order
    function generateOrder() {
        currentOrder = [];
        const numIngredients = 3 + Math.floor(Math.random() * 3); // 3-5 ингредиентов
        
        for (let i = 0; i < numIngredients; i++) {
            const randomIng = ingredients[Math.floor(Math.random() * ingredients.length)];
            currentOrder.push(randomIng);
        }
        
        displayOrder();
    }
    
    function displayOrder() {
        const orderDiv = document.getElementById('order-display');
        orderDiv.innerHTML = currentOrder.map(ing => 
            `<div style="font-size: 36px;">${ing.emoji}</div>`
        ).join('');
    }
    
    function displayPlayerBurger() {
        const burgerDiv = document.getElementById('player-burger');
        burgerDiv.innerHTML = playerBurger.map(ing => 
            `<div style="font-size: 36px;">${ing}</div>`
        ).join('');
    }
    
    window.addIngredient = function(id, emoji) {
        vibrate('light');
        playerBurger.push(emoji);
        displayPlayerBurger();
    };
    
    window.clearBurger = function() {
        vibrate('light');
        playerBurger = [];
        displayPlayerBurger();
    };
    
    window.checkBurger = function() {
        vibrate('medium');
        
        // Check if correct
        const correct = playerBurger.length === currentOrder.length &&
                       playerBurger.every((ing, i) => ing === currentOrder[i].emoji);
        
        if (correct) {
            score += 10;
            vibrate('heavy');
            playerBurger = [];
            generateOrder();
            displayPlayerBurger();
        } else {
            score = Math.max(0, score - 5);
        }
        
        document.getElementById('burger-score').textContent = score;
    };
    
    // Timer
    const timer = setInterval(() => {
        timeLeft--;
        document.getElementById('burger-time').textContent = timeLeft;
        
        if (timeLeft <= 0) {
            clearInterval(timer);
            endGame('burger_maker', score);
        }
    }, 1000);
    
    // Start
    generateOrder();
}

// Game 2: Order Rush - выполняйте заказы быстро
function initOrderRush(container) {
    let score = 0;
    let timeLeft = 45;
    let currentOrder = null;
    
    const menuItems = [
        { name: 'Бургер', emoji: '🍔', time: 3 },
        { name: 'Картошка', emoji: '🍟', time: 2 },
        { name: 'Напиток', emoji: '🥤', time: 1 },
        { name: 'Пицца', emoji: '🍕', time: 4 },
        { name: 'Хот-дог', emoji: '🌭', time: 2 }
    ];
    
    container.innerHTML = `
        <div class="game-board">
            <div class="game-score">
                <div>Заказов: <span id="rush-score">0</span></div>
                <div>Время: <span id="rush-time">45</span>с</div>
            </div>
            
            <div id="current-order" style="text-align: center; padding: 30px; background: rgba(255,255,255,0.05); border-radius: 15px; margin-bottom: 20px; min-height: 150px;">
                <div style="font-size: 20px; margin-bottom: 10px; font-weight: bold;">Клиент хочет:</div>
                <div style="font-size: 60px; margin: 20px 0;" id="order-item">🍔</div>
                <div style="font-size: 16px; color: #B8B8D1;" id="order-name">Бургер</div>
                <div style="margin-top: 15px;">
                    <div style="background: rgba(78, 205, 196, 0.2); height: 8px; border-radius: 4px; overflow: hidden;">
                        <div id="order-progress" style="background: #4ECDC4; height: 100%; width: 100%; transition: width 0.1s linear;"></div>
                    </div>
                </div>
            </div>
            
            <div class="game-grid" style="grid-template-columns: repeat(2, 1fr); gap: 15px;">
                ${menuItems.map((item, index) => `
                    <button class="game-btn" onclick="serveItem(${index})" style="padding: 20px; font-size: 20px;">
                        ${item.emoji}<br>${item.name}
                    </button>
                `).join('')}
            </div>
        </div>
    `;
    
    let orderProgress = 100;
    let orderTimer = null;
    
    function newOrder() {
        currentOrder = menuItems[Math.floor(Math.random() * menuItems.length)];
        
        document.getElementById('order-item').textContent = currentOrder.emoji;
        document.getElementById('order-name').textContent = currentOrder.name;
        
        orderProgress = 100;
        
        // Clear old timer
        if (orderTimer) clearInterval(orderTimer);
        
        // Start order timer
        orderTimer = setInterval(() => {
            orderProgress -= (100 / (currentOrder.time * 10));
            
            if (orderProgress <= 0) {
                clearInterval(orderTimer);
                score = Math.max(0, score - 2);
                document.getElementById('rush-score').textContent = score;
                newOrder();
            }
            
            document.getElementById('order-progress').style.width = orderProgress + '%';
        }, 100);
    }
    
    window.serveItem = function(index) {
        vibrate('light');
        
        const served = menuItems[index];
        
        if (served.name === currentOrder.name) {
            vibrate('heavy');
            score += Math.ceil(orderProgress / 10); // Bonus for speed
            clearInterval(orderTimer);
            newOrder();
        } else {
            vibrate('medium');
            score = Math.max(0, score - 3);
        }
        
        document.getElementById('rush-score').textContent = score;
    };
    
    // Game timer
    const gameTimer = setInterval(() => {
        timeLeft--;
        document.getElementById('rush-time').textContent = timeLeft;
        
        if (timeLeft <= 0) {
            clearInterval(gameTimer);
            clearInterval(orderTimer);
            endGame('order_rush', score);
        }
    }, 1000);
    
    // Start
    newOrder();
}

// Game 3: Memory Menu - запоминай меню
function initMemoryMenu(container) {
    let score = 0;
    let round = 1;
    let sequence = [];
    let playerSequence = [];
    let canPlay = false;
    
    const items = [
        { emoji: '🍔', name: 'Бургер' },
        { emoji: '🍟', name: 'Картошка' },
        { emoji: '🥤', name: 'Напиток' },
        { emoji: '🍕', name: 'Пицца' },
        { emoji: '🌭', name: 'Хот-дог' },
        { emoji: '🌮', name: 'Тако' }
    ];
    
    container.innerHTML = `
        <div class="game-board">
            <div class="game-score">
                <div>Раунд: <span id="memory-round">1</span></div>
                <div>Счет: <span id="memory-score">0</span></div>
            </div>
            
            <div style="text-align: center; padding: 30px; margin-bottom: 20px;">
                <div id="memory-message" style="font-size: 18px; font-weight: bold; margin-bottom: 20px;">
                    Запомните последовательность!
                </div>
                <div id="memory-display" style="font-size: 80px; min-height: 100px;">
                    
                </div>
            </div>
            
            <div class="game-grid" style="grid-template-columns: repeat(3, 1fr); gap: 15px;">
                ${items.map((item, index) => `
                    <button class="game-btn" onclick="selectItem(${index})" id="btn-${index}" style="font-size: 36px; padding: 20px;" disabled>
                        ${item.emoji}
                    </button>
                `).join('')}
            </div>
        </div>
    `;
    
    async function playSequence() {
        canPlay = false;
        playerSequence = [];
        
        // Add new item to sequence
        sequence.push(Math.floor(Math.random() * items.length));
        
        document.getElementById('memory-message').textContent = 'Запомните последовательность!';
        
        // Disable buttons
        items.forEach((_, i) => {
            document.getElementById(`btn-${i}`).disabled = true;
        });
        
        // Show sequence
        for (let i = 0; i < sequence.length; i++) {
            await new Promise(resolve => setTimeout(resolve, 500));
            
            const itemIndex = sequence[i];
            const display = document.getElementById('memory-display');
            display.textContent = items[itemIndex].emoji;
            vibrate('light');
            
            await new Promise(resolve => setTimeout(resolve, 800));
            display.textContent = '';
        }
        
        // Enable buttons
        document.getElementById('memory-message').textContent = 'Повторите последовательность!';
        items.forEach((_, i) => {
            document.getElementById(`btn-${i}`).disabled = false;
        });
        
        canPlay = true;
    }
    
    window.selectItem = function(index) {
        if (!canPlay) return;
        
        vibrate('light');
        
        playerSequence.push(index);
        
        // Show feedback
        const display = document.getElementById('memory-display');
        display.textContent = items[index].emoji;
        setTimeout(() => display.textContent = '', 300);
        
        // Check if correct
        const currentIndex = playerSequence.length - 1;
        
        if (playerSequence[currentIndex] !== sequence[currentIndex]) {
            // Wrong!
            vibrate('heavy');
            canPlay = false;
            document.getElementById('memory-message').textContent = '❌ Ошибка!';
            
            setTimeout(() => {
                endGame('memory_menu', score);
            }, 1500);
            return;
        }
        
        // Check if sequence complete
        if (playerSequence.length === sequence.length) {
            vibrate('heavy');
            score += round * 5;
            round++;
            
            document.getElementById('memory-score').textContent = score;
            document.getElementById('memory-round').textContent = round;
            
            canPlay = false;
            document.getElementById('memory-message').textContent = '✅ Правильно!';
            
            setTimeout(() => {
                playSequence();
            }, 1500);
        }
    };
    
    // Start first round
    setTimeout(() => playSequence(), 1000);
}

// End game and save score
async function endGame(gameType, score) {
    vibrate('heavy');
    
    const container = document.getElementById('game-container');
    
    // Calculate reward
    const baseRewards = {
        'burger_maker': 50,
        'order_rush': 75,
        'memory_menu': 100
    };
    
    const reward = baseRewards[gameType] * (1 + score / 100);
    
    container.innerHTML = `
        <div class="game-board" style="text-align: center; padding: 40px 20px;">
            <div style="font-size: 80px; margin-bottom: 20px;">🎉</div>
            <h2 style="margin-bottom: 10px;">Игра окончена!</h2>
            <div style="font-size: 48px; font-weight: bold; margin: 20px 0; color: #FFD93D;">
                ${score} очков
            </div>
            <div style="font-size: 24px; margin: 20px 0; color: #95E1D3;">
                Награда: +$${formatNumber(reward)}
            </div>
            <button class="game-btn" onclick="claimReward('${gameType}', ${score}, ${reward})" 
                    style="margin-top: 20px; background: linear-gradient(135deg, #4ECDC4, #3DBDB4);">
                💰 Забрать награду
            </button>
        </div>
    `;
}

// Claim game reward
window.claimReward = async function(gameType, score, reward) {
    vibrate('heavy');
    
    try {
        const response = await fetch(`${API_URL}/minigame`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                user_id: userData.user.user_id,
                game_type: gameType,
                score: score
            })
        });
        
        const result = await response.json();
        
        if (result.success) {
            userData.user = result.user;
            updateMainScreen();
            showNotification(`✅ Получено $${formatNumber(result.reward)}!`, 'success');
        }
        
    } catch (error) {
        console.error('Error claiming reward:', error);
        // Fallback: update locally
        userData.user.balance += reward;
        userData.user.total_earned += reward;
        userData.user.minigames_played++;
        updateMainScreen();
        showNotification(`✅ Получено $${formatNumber(reward)}!`, 'success');
    }
    
    closeGameModal();
};
