const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const webpush = require('web-push');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');

// ===== VAPID КЛЮЧИ =====
// Сгенерируйте свои ключи командой: npx web-push generate-vapid-keys
const vapidKeys = {
    publicKey: 'BFDXq8vQvHR-_AZz25CYHMTKwxMafwkMLsE4B5Pl2xwpmyiafTkn4ZRtHxxcr5uGr2Gs5aI1fpJMNm-4ViQ7G60',
    privateKey: 'fzMZmkQnPKXGdaWnLYk0TXxrDhy2pTjU9m8sLIaNbQY'
};

webpush.setVapidDetails(
    'mailto:your-email@example.com',
    vapidKeys.publicKey,
    vapidKeys.privateKey
);

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, './')));

// ===== ХРАНИЛИЩЕ ПОДПИСОК (используем Map для надёжного удаления) =====
const subscriptions = new Map();

const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// ===== WebSocket подключения =====
io.on('connection', (socket) => {
    console.log('🔗 Клиент подключён:', socket.id);

    // Обработка события 'newTask' от клиента
    socket.on('newTask', (task) => {
        console.log('📝 Новая задача:', task);

        // Рассылаем событие всем подключённым клиентам через WebSocket
        io.emit('taskAdded', task);

        // Отправляем push-уведомление всем подписанным клиентам
        const payload = JSON.stringify({
            title: '📝 Новая задача',
            body: task.text || 'Добавлена новая заметка',
            icon: '/icons/icon-192x192.png',
            badge: '/icons/icon-192x192.png',
            tag: 'new-task',
            requireInteraction: false
        });

        // Отправляем push всем активным подпискам
        for (const [endpoint, subscription] of subscriptions) {
            webpush.sendNotification(subscription, payload)
                .then(() => {
                    console.log('✅ Push отправлен:', endpoint);
                })
                .catch(err => {
                    console.error('❌ Push error:', err.message);
                    
                    // Если подписка недействительна (410/404) - удаляем её
                    if (err.statusCode === 410 || err.statusCode === 404) {
                        console.log('🗑️ Удаляем недействительную подписку:', endpoint);
                        subscriptions.delete(endpoint);
                    }
                });
        }
    });

    socket.on('disconnect', () => {
        console.log('❌ Клиент отключён:', socket.id);
    });
});

// ===== Эндпоинты для push-подписок =====

// Подписка на push-уведомления
app.post('/subscribe', (req, res) => {
    try {
        const subscription = req.body;
        
        if (!subscription || !subscription.endpoint) {
            return res.status(400).json({ 
                success: false, 
                error: 'Invalid subscription data' 
            });
        }
        
        // Используем endpoint как уникальный ключ
        const endpoint = subscription.endpoint;
        
        // Проверяем, нет ли уже такой подписки
        if (subscriptions.has(endpoint)) {
            console.log('ℹ️ Подписка уже существует:', endpoint);
            return res.status(200).json({ 
                success: true, 
                message: 'Подписка уже активна' 
            });
        }
        
        // Сохраняем подписку
        subscriptions.set(endpoint, subscription);
        
        console.log('✅ Новая подписка. Всего:', subscriptions.size);
        console.log('   Endpoint:', endpoint);
        
        res.status(201).json({ 
            success: true, 
            message: 'Подписка сохранена',
            count: subscriptions.size
        });
        
    } catch (error) {
        console.error('❌ Ошибка подписки:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Отписка от push-уведомлений (ИСПРАВЛЕННАЯ ВЕРСИЯ)
app.post('/unsubscribe', (req, res) => {
    try {
        const { endpoint } = req.body;
        
        if (!endpoint) {
            return res.status(400).json({ 
                success: false, 
                error: 'Endpoint is required' 
            });
        }
        
        // Удаляем подписку по endpoint
        const wasDeleted = subscriptions.delete(endpoint);
        
        if (wasDeleted) {
            console.log('✅ Подписка удалена:', endpoint);
            console.log('   Осталось подписок:', subscriptions.size);
            
            res.status(200).json({ 
                success: true, 
                message: 'Подписка удалена',
                count: subscriptions.size
            });
        } else {
            console.log('⚠️ Подписка не найдена:', endpoint);
            
            res.status(200).json({ 
                success: true, 
                message: 'Подписка не найдена (уже удалена?)',
                count: subscriptions.size
            });
        }
        
    } catch (error) {
        console.error('❌ Ошибка отписки:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Получение публичного VAPID ключа для клиента
app.get('/vapid-public-key', (req, res) => {
    res.json({ 
        success: true,
        publicKey: vapidKeys.publicKey 
    });
});

// ===== ТЕСТОВЫЙ ЭНДПОИНТ ДЛЯ ПРОВЕРКИ =====
// Отправляет тестовое уведомление всем подписчикам
app.post('/test-push', (req, res) => {
    const { message } = req.body || {};
    const title = message?.title || '🔔 Тестовое уведомление';
    const body = message?.body || 'Это тестовое push-уведомление';
    
    const payload = JSON.stringify({
        title: title,
        body: body,
        icon: '/icons/icon-192x192.png',
        badge: '/icons/icon-192x192.png'
    });
    
    let sent = 0;
    let failed = 0;
    
    for (const [endpoint, subscription] of subscriptions) {
        webpush.sendNotification(subscription, payload)
            .then(() => sent++)
            .catch(err => {
                failed++;
                console.error('❌ Push error:', err.message);
                if (err.statusCode === 410 || err.statusCode === 404) {
                    subscriptions.delete(endpoint);
                }
            });
    }
    
    res.json({
        success: true,
        message: `Отправка запущена: ${subscriptions.size} подписок`,
        sent: sent,
        failed: failed
    });
});

// ===== СТАТУС СЕРВЕРА =====
app.get('/api/status', (req, res) => {
    res.json({
        success: true,
        server: 'running',
        uptime: process.uptime(),
        subscriptions: subscriptions.size,
        connectedClients: io.engine.clientsCount
    });
});

// ===== ОБРАБОТКА НЕИЗВЕСТНЫХ МАРШРУТОВ =====
app.use((req, res) => {
    res.status(404).json({ 
        success: false, 
        error: 'Endpoint not found' 
    });
});

// ===== ОБРАБОТКА ОШИБОК =====
app.use((err, req, res, next) => {
    console.error('❌ Server error:', err);
    res.status(500).json({ 
        success: false, 
        error: err.message 
    });
});

// ===== ЗАПУСК СЕРВЕРА =====
const PORT = 3001;
server.listen(PORT, () => {
    console.log('\n' + '='.repeat(50));
    console.log('🚀 Сервер заметок запущен');
    console.log('📡 Порт:', PORT);
    console.log('🌐 URL: http://localhost:' + PORT);
    console.log('🔔 Push-уведомления: ВКЛЮЧЕНЫ');
    console.log('📊 Подписок:', subscriptions.size);
    console.log('='.repeat(50) + '\n');
});

// ===== ОБРАБОТКА ЗАВЕРШЕНИЯ РАБОТЫ =====
process.on('SIGINT', () => {
    console.log('\n🛑 Завершение работы сервера...');
    console.log('💾 Сохранено подписок:', subscriptions.size);
    server.close(() => {
        console.log('✅ Сервер остановлен');
        process.exit(0);
    });
});