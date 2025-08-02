const express = require('express');
const path = require('path');
const cors = require('cors');
const { Client, Environment } = require('square');

const app = express();
const PORT = 3000;

// Production Square Configuration
const squareClient = new Client({
    accessToken: 'EAAAlw4Yo9LxE43QR7HdJWyzHZMAyU4JJLSIlYlzq-Z6z_I14cYYB_j9Twnci4jk',
    environment: Environment.Production
});

const { paymentsApi, locationsApi, customersApi, bookingsApi } = squareClient;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('.')); // Serve static files from current directory

// Get location ID (you'll need to run this once to get your location ID)
app.get('/api/locations', async (req, res) => {
    try {
        const response = await locationsApi.listLocations();
        const locations = response.result.locations || [];
        res.json(locations);
    } catch (error) {
        console.error('Error fetching locations:', error);
        res.status(500).json({ error: 'Failed to fetch locations' });
    }
});

// Process booking payment (50% DEPOSIT SYSTEM)
app.post('/api/process-booking-payment', async (req, res) => {
    const { sourceId, amount, currency = 'USD', booking, saveCard = false, usingSavedCard = false } = req.body;

    try {
        // Calculate 50% deposit amount (amount is already in cents)
        const fullAmount = amount;
        const depositAmount = Math.round(fullAmount * 0.5);
        const remainingAmount = fullAmount - depositAmount;

        console.log('💳 DEPOSIT PAYMENT PROCESSING:', {
            fullServiceAmount: `$${(fullAmount / 100).toFixed(2)}`,
            depositAmount: `$${(depositAmount / 100).toFixed(2)}`,
            remainingAmount: `$${(remainingAmount / 100).toFixed(2)}`,
            customer: `${booking.customerInfo.firstName} ${booking.customerInfo.lastName}`
        });

        // Create payment request for DEPOSIT ONLY
        const paymentRequest = {
            sourceId,
            amountMoney: {
                amount: depositAmount, // 50% deposit in cents
                currency: currency.toUpperCase()
            },
            locationId: 'LSCFYPEXP7Y2N', // Production location ID for "The Shop"
            idempotencyKey: `deposit-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            note: `50% DEPOSIT for ${booking.customerInfo.firstName} ${booking.customerInfo.lastName} - Remaining $${(remainingAmount / 100).toFixed(2)} due at appointment`,
            buyerEmailAddress: booking.customerInfo.email
        };

        // Process the payment
        const paymentResponse = await paymentsApi.createPayment(paymentRequest);

        if (paymentResponse.result.payment) {
            const payment = paymentResponse.result.payment;

            // Create customer in Square
            const customer = await createOrFindCustomer(booking.customerInfo);

            // Create actual appointment booking in Square
            const appointmentBooking = await createSquareBooking(booking, customer.id, payment.id);

            // Calculate total duration for admin display
            let totalDurationMinutes = 0;
            booking.selectedServices.forEach(service => {
                if (service.durationMinutes) {
                    totalDurationMinutes += service.durationMinutes;
                } else if (service.duration) {
                    totalDurationMinutes += parseDurationToMinutes(service.duration);
                } else {
                    totalDurationMinutes += 60; // Default 1 hour
                }
            });

            // Save booking with deposit details to our system
            const bookingData = {
                id: `deposit-booking-${Date.now()}`,
                paymentId: payment.id,
                squareBookingId: appointmentBooking.id,
                customerId: customer.id,
                customerName: `${booking.customerInfo.firstName} ${booking.customerInfo.lastName}`,
                customerPhone: booking.customerInfo.phone,
                customerEmail: booking.customerInfo.email,
                services: booking.selectedServices,
                totalDurationMinutes: totalDurationMinutes, // For admin display
                date: formatDateSafe(booking.selectedDate),
                time: booking.selectedTime,
                totalAmount: fullAmount / 100, // Convert back to dollars
                depositPaid: depositAmount / 100,
                remainingBalance: remainingAmount / 100,
                status: 'CONFIRMED',
                paymentMethod: 'Square (Online)',
                paymentType: 'deposit',
                bookingSource: 'online', // Tag for identifying online vs manual bookings
                refundStatus: 'none', // none, partial, full
                refundAmount: 0,
                notes: booking.customerInfo.notes || '',
                createdAt: new Date().toISOString(),
                isMainBooking: true
            };

            // Save to our bookings file
            const fs = require('fs');
            let bookings = readBookingsFile();
            bookings.push(bookingData);
            fs.writeFileSync('bookings.json', JSON.stringify(bookings, null, 2));

            // Log successful DEPOSIT booking
            console.log('💰 DEPOSIT BOOKING CREATED & SAVED:', {
                paymentId: payment.id,
                bookingId: appointmentBooking.id,
                customerId: customer.id,
                depositPaid: `$${(depositAmount / 100).toFixed(2)}`,
                fullServiceAmount: `$${(fullAmount / 100).toFixed(2)}`,
                remainingBalance: `$${(remainingAmount / 100).toFixed(2)}`,
                customer: booking.customerInfo,
                services: booking.selectedServices,
                date: booking.selectedDate,
                time: booking.selectedTime,
                status: payment.status,
                paymentType: '50% DEPOSIT'
            });

            // Save customer card if requested (only for new cards, not saved cards)
            let savedCard = null;
            if (saveCard && !usingSavedCard && sourceId) {
                try {
                    console.log('💳 SAVING CUSTOMER CARD for future use...');
                    savedCard = await saveCustomerCard(sourceId, customer.id);
                    console.log('✅ CARD SAVED SUCCESSFULLY:', savedCard.id);
                } catch (cardError) {
                    console.error('❌ Failed to save customer card:', cardError);
                    // Don't fail the whole payment if card saving fails
                }
            }

            // Send booking confirmation email (implement with your email service)
            await sendBookingConfirmationEmail(booking, payment);

            res.json({
                success: true,
                paymentId: payment.id,
                bookingId: appointmentBooking.id,
                customerId: customer.id,
                status: payment.status,
                paymentType: 'deposit',
                depositAmount: depositAmount,
                remainingAmount: remainingAmount,
                fullAmount: fullAmount,
                booking: booking,
                cardSaved: !!savedCard
            });
        } else {
            throw new Error('Payment processing failed');
        }

    } catch (error) {
        console.error('Payment error:', error);

        let errorMessage = 'Payment processing failed';
        if (error.errors && error.errors.length > 0) {
            errorMessage = error.errors[0].detail || errorMessage;
        }

        res.status(400).json({
            success: false,
            error: errorMessage,
            details: error.errors || []
        });
    }
});

// Helper function to create or find customer in Square
async function createOrFindCustomer(customerInfo) {
    try {
        // Search for existing customer by email
        const searchResponse = await customersApi.searchCustomers({
            query: {
                filter: {
                    emailAddress: {
                        exact: customerInfo.email
                    }
                }
            }
        });

        if (searchResponse.result.customers && searchResponse.result.customers.length > 0) {
            return searchResponse.result.customers[0];
        }

        // Create new customer if not found
        const createResponse = await customersApi.createCustomer({
            givenName: customerInfo.firstName,
            familyName: customerInfo.lastName,
            emailAddress: customerInfo.email,
            phoneNumber: customerInfo.phone,
            note: customerInfo.notes || ''
        });

        return createResponse.result.customer;
    } catch (error) {
        console.error('Error creating/finding customer:', error);
        throw error;
    }
}

// Helper function to create actual booking in Square
async function createSquareBooking(booking, customerId, paymentId) {
    try {
        // Parse date and time for booking
        const appointmentDate = new Date(booking.selectedDate);
        const [time, period] = booking.selectedTime.split(' ');
        const [hours, minutes] = time.split(':');
        let hour24 = parseInt(hours);

        if (period === 'PM' && hour24 !== 12) hour24 += 12;
        if (period === 'AM' && hour24 === 12) hour24 = 0;

        appointmentDate.setHours(hour24, parseInt(minutes), 0, 0);

        // Create the booking request
        const bookingRequest = {
            booking: {
                locationId: 'LSCFYPEXP7Y2N',
                startAt: appointmentDate.toISOString(),
                customerId: customerId,
                customerNote: booking.customerInfo.notes || '',
                sellerNote: `Services: ${booking.selectedServices.map(s => s.name).join(', ')} | Payment ID: ${paymentId} | Total: $${booking.totalAmount}`,
                appointmentSegments: [{
                    durationMinutes: Math.max(60, Math.ceil((booking.totalDurationMinutes || 60) / 60) * 60), // Always hour intervals: 60, 120, 180 minutes
                    serviceVariationId: 'default-service' // Generic service - Mary can customize in Square
                }]
            }
        };

        const response = await bookingsApi.createBooking(bookingRequest);
        return response.result.booking;

    } catch (error) {
        console.error('Error creating Square booking:', error);
        // Return mock booking to not fail payment, but log the error
        return {
            id: `localhost-booking-${Date.now()}`,
            status: 'PENDING',
            note: 'Created via website - check Square dashboard'
        };
    }
}

// Send booking confirmation emails to both Mary and customer
async function sendBookingConfirmationEmail(booking, payment) {
    try {
        const https = require('https');
        const querystring = require('querystring');

        // 1. Send notification to Mary (beautywithmare@gmail.com)
        const maryEmailData = querystring.stringify({
            '_subject': '💰 NEW DEPOSIT BOOKING RECEIVED',
            'customer_name': `${booking.customerInfo.firstName} ${booking.customerInfo.lastName}`,
            'customer_phone': booking.customerInfo.phone,
            'customer_email': booking.customerInfo.email,
            'services': booking.selectedServices.map(s => `${s.name} - $${s.price}`).join(', '),
            'appointment_date': new Date(booking.selectedDate).toLocaleDateString(),
            'appointment_time': booking.selectedTime,
            'total_service_amount': `$${booking.totalAmount.toFixed(2)}`,
            'deposit_paid': `$${(depositAmount / 100).toFixed(2)}`,
            'remaining_balance': `$${(remainingAmount / 100).toFixed(2)}`,
            'payment_method': 'Online (Square - 50% Deposit)',
            'payment_id': payment.id,
            'notes': booking.customerInfo.notes || 'None',
            'booking_type': '50% DEPOSIT PAID - Balance Due at Appointment',
            'cancellation_policy': 'Customer must call/text (443) 528-5571 to cancel',
            '_template': 'box'
        });

        const maryOptions = {
            hostname: 'formspree.io',
            port: 443,
            path: '/f/xpwlqjnv',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(maryEmailData),
                'Accept': 'application/json'
            }
        };

        const maryReq = https.request(maryOptions, (maryRes) => {
            console.log('📧 Booking notification sent to Mary');
        });

        maryReq.on('error', (error) => {
            console.error('Mary email notification failed:', error);
        });

        maryReq.write(maryEmailData);
        maryReq.end();

        // Customer confirmation emails don't work with Formspree (only sends to form owner)
        // Mary gets notified above and will contact customer if needed

        console.log('✅ DEPOSIT NOTIFICATION SENT TO MARY:', {
            customer: `${booking.customerInfo.firstName} ${booking.customerInfo.lastName}`,
            customerEmail: booking.customerInfo.email,
            maryNotification: 'beautywithmare@gmail.com',
            services: booking.selectedServices.map(s => s.name).join(', '),
            totalServiceAmount: `$${booking.totalAmount.toFixed(2)}`,
            depositPaid: `$${(depositAmount / 100).toFixed(2)}`,
            remainingBalance: `$${(remainingAmount / 100).toFixed(2)}`,
            paymentType: '50% DEPOSIT'
        });

    } catch (error) {
        console.error('Failed to send confirmation emails:', error);
    }
}

// Get availability for a specific date
app.get('/api/get-availability', async (req, res) => {
    try {
        const { date, slotsNeeded = 1, duration = 60 } = req.query;

        if (!date) {
            return res.status(400).json({ error: 'Date parameter required' });
        }

        console.log('🔍 CUSTOMER AVAILABILITY REQUEST:', { date, slotsNeeded, duration });

        // All possible time slots
        const allSlots = [
            '9:00 AM', '10:00 AM', '11:00 AM', '12:00 PM', '1:00 PM', '2:00 PM',
            '3:00 PM', '4:00 PM', '5:00 PM', '6:00 PM', '7:00 PM', '8:00 PM', '9:00 PM'
        ];

        // Read files
        const bookings = readBookingsFile();
        const blockedTimes = readBlockedTimesFile();
        const personalEvents = readPersonalEventsFile();

        // Get current date/time for validation
        const now = new Date();
        const requestDate = new Date(date + 'T00:00:00');
        const isToday = requestDate.toDateString() === now.toDateString();

        const availableSlots = [];

        for (const slot of allSlots) {
            let isAvailable = true;
            let blockReason = '';

            // Check if it's in the past (today only)
            if (isToday) {
                const slotTime = parseTimeSlot(slot);
                const currentTime = now.getHours() + (now.getMinutes() / 60);
                if (slotTime <= currentTime) {
                    console.log(`⏰ ${slot} is in the past`);
                    continue;
                }
            }

            // Check for bookings
            const isBooked = bookings.some(b => b.date === date && b.time === slot);
            if (isBooked) {
                console.log(`📅 ${slot} is already booked`);
                isAvailable = false;
                blockReason = 'booked';
            }

            // Check for manually blocked times
            if (isAvailable) {
                const isBlocked = blockedTimes.some(bt => bt.date === date && bt.time === slot);
                if (isBlocked) {
                    console.log(`🚫 ${slot} is manually blocked`);
                    isAvailable = false;
                    blockReason = 'blocked';
                }
            }

            // Check for personal events
            if (isAvailable) {
                const dayEvents = personalEvents.filter(e => e.date === date);
                for (const event of dayEvents) {
                    const eventStartTime = parseTimeSlot(event.time);
                    const eventDurationHours = event.duration / 60;
                    const eventEndTime = eventStartTime + eventDurationHours;
                    const slotTime = parseTimeSlot(slot);

                    if (slotTime >= eventStartTime && slotTime < eventEndTime) {
                        console.log(`👩‍⚕️ ${slot} blocked by personal event: ${event.title}`);
                        isAvailable = false;
                        blockReason = `personal event: ${event.title}`;
                        break;
                    }
                }
            }

            // Check if too late for service (cutoff at 7 PM for 1+ hour services)
            if (isAvailable) {
                const serviceDuration = parseInt(duration) || 60;
                const slotTime = parseTimeSlot(slot);
                const cutoffTime = serviceDuration >= 60 ? 19 : 21; // 7 PM for 1+ hour, 9 PM for shorter

                if (slotTime + (serviceDuration / 60) > cutoffTime) {
                    console.log(`⏰ ${slot} too late for ${serviceDuration}-minute service`);
                    continue;
                }
            }

            if (isAvailable) {
                availableSlots.push(slot);
                console.log(`✅ ${slot} available`);
            }
        }

        console.log(`📅 Available slots for ${date}:`, availableSlots.length, 'slots');

        res.json({
            success: true,
            date: date,
            availableSlots: availableSlots
        });

    } catch (error) {
        console.error('Error getting availability:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get availability',
            details: error.message
        });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'OK', message: 'Square booking server is running' });
});

// Admin login page
app.get('/admin-login.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin-login.html'));
});

// Admin panel (direct access)
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// Analytics login page
app.get('/analytics-login', (req, res) => {
    res.sendFile(path.join(__dirname, 'analytics-login.html'));
});

// Analytics dashboard
app.get('/analytics', (req, res) => {
    res.sendFile(path.join(__dirname, 'analytics.html'));
});

// Calendar view route
app.get('/calendar', (req, res) => {
    const { month, year } = req.query;
    const currentDate = new Date();
    const targetDate = new Date(year || currentDate.getFullYear(), (month || currentDate.getMonth()));

    const bookings = readBookingsFile();
    const blockedTimes = readBlockedTimesFile();

    // Generate calendar HTML with full functionality
    const calendarHTML = generateCalendarHTML(targetDate, bookings, blockedTimes);
    res.send(calendarHTML);
});

// Manage specific day route
app.get('/manage-day', (req, res) => {
    const { date } = req.query;
    const bookings = readBookingsFile();
    const blockedTimes = readBlockedTimesFile();

    const manageDayHTML = generateManageDayHTML(date, bookings, blockedTimes);
    res.send(manageDayHTML);
});

// Generate full calendar HTML
function generateCalendarHTML(targetDate, bookings, blockedTimes) {
    const year = targetDate.getFullYear();
    const month = targetDate.getMonth();
    const monthName = targetDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    // Get bookings for this month
    const monthBookings = bookings.filter(b => {
        const bookingDate = new Date(b.date);
        return bookingDate.getFullYear() === year && bookingDate.getMonth() === month;
    });

    // Calendar navigation
    const prevMonth = new Date(year, month - 1);
    const nextMonth = new Date(year, month + 1);
    const canGoPrev = prevMonth >= new Date(new Date().getFullYear(), new Date().getMonth() - 1);
    const canGoNext = nextMonth <= new Date(new Date().getFullYear(), new Date().getMonth() + 6);

    return `
    <!DOCTYPE html>
    <html>
    <head>
        <title>Calendar - Beauty With Mare</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
            @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap');
            
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { 
                font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                background: linear-gradient(135deg, #8E44AD 0%, #9B59B6 50%, #663399 100%) !important;
                min-height: 100vh;
                padding: 16px;
                padding-bottom: 140px;
                color: #4a3d52 !important;
                font-weight: 400;
            }
            
            .container {
                max-width: 1400px;
                margin: 0 auto;
                background: linear-gradient(145deg, #ffffff, #fdfbfe) !important;
                border-radius: 28px;
                box-shadow: 0 25px 50px rgba(155, 124, 182, 0.15), 0 0 0 1px rgba(155, 124, 182, 0.1) !important;
                overflow: hidden;
                backdrop-filter: blur(20px);
            }
            
            .header {
                background: linear-gradient(135deg, #8E44AD 0%, #9B59B6 50%, #663399 100%) !important;
                color: #ffffff !important;
                padding: 40px;
                text-align: center;
                display: flex;
                justify-content: space-between;
                align-items: center;
                position: relative;
                overflow: hidden;
                border: none !important;
            }
            
            .header::before {
                content: '';
                position: absolute;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: linear-gradient(45deg, transparent 30%, rgba(255,255,255,0.1) 50%, transparent 70%);
                animation: shimmer 4s infinite;
            }
            
            @keyframes shimmer {
                0% { transform: translateX(-100%); }
                100% { transform: translateX(100%); }
            }
            
            .header h1 {
                font-size: 2.4em;
                font-weight: 800;
                letter-spacing: -0.02em;
                position: relative;
                z-index: 1;
                text-shadow: 0 2px 4px rgba(0,0,0,0.1);
            }
            
            .nav-btn {
                background: rgba(255, 255, 255, 0.95);
                border: 1px solid rgba(155, 124, 182, 0.3);
                color: #4a3d52;
                padding: 14px 20px;
                border-radius: 14px;
                cursor: pointer;
                font-size: 16px;
                font-weight: 600;
                transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                backdrop-filter: blur(10px);
                position: relative;
                z-index: 1;
            }
            
            .nav-btn:hover:not(:disabled) {
                background: rgba(255, 255, 255, 1);
                transform: translateY(-3px);
                box-shadow: 0 8px 25px rgba(155, 124, 182, 0.4);
                border-color: rgba(155, 124, 182, 0.6);
            }
            
            .nav-btn:disabled {
                opacity: 0.3;
                cursor: not-allowed;
                background: rgba(255, 255, 255, 0.5);
            }
            
            .calendar {
                padding: 40px;
                background: transparent;
            }
            
            .calendar-grid {
                display: grid;
                grid-template-columns: repeat(7, 1fr);
                gap: 3px;
                margin-top: 32px;
                border-radius: 16px;
                overflow: hidden;
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
            }
            
            .day-header {
                background: linear-gradient(145deg, #fdfbfe, #f0e8f5);
                padding: 20px 8px;
                text-align: center;
                font-weight: 700;
                color: #7a5a96;
                font-size: 13px;
                letter-spacing: 0.5px;
                text-transform: uppercase;
                border-bottom: 1px solid rgba(155, 124, 182, 0.3);
            }
            
            .day-cell {
                min-height: 140px;
                border: 1px solid rgba(255, 255, 255, 0.05);
                padding: 12px;
                background: linear-gradient(145deg, #c4b1d6, #9b7cb6);
                position: relative;
                cursor: pointer;
                transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                overflow: hidden;
            }
            
            .day-cell:hover {
                background: linear-gradient(145deg, #9B59B6, #8E44AD);
                transform: translateY(-2px);
                box-shadow: 0 8px 25px rgba(155, 124, 182, 0.4);
                border-color: rgba(155, 124, 182, 0.6);
            }
            
            .day-number {
                font-weight: 700;
                margin-bottom: 8px;
                color: #ffffff;
                font-size: 16px;
                position: relative;
                z-index: 2;
            }
            
            .other-month {
                opacity: 0.25;
                filter: grayscale(0.7);
            }
            
            .today {
                background: linear-gradient(145deg, #9b7cb6, #7a5a96) !important;
                border-color: #BFA8D1 !important;
                border-width: 2px !important;
                box-shadow: 0 0 0 2px rgba(191, 168, 209, 0.4), 0 8px 25px rgba(155, 124, 182, 0.5) !important;
                transform: scale(1.02) !important;
            }
            
            .today .day-number {
                color: #ffffff;
                text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
                font-weight: 800;
            }
            
            .entire-day-blocked {
                background: linear-gradient(145deg, #4a1a1a, #3a1414) !important;
                border-color: #ff6b6b !important;
                border-width: 2px !important;
                box-shadow: 0 0 0 1px rgba(255, 107, 107, 0.3) !important;
            }
            
            .entire-day-blocked:hover {
                background: linear-gradient(145deg, #5a2424, #4a1e1e) !important;
                border-color: #ff8888 !important;
                box-shadow: 0 8px 25px rgba(255, 107, 107, 0.4) !important;
            }
            
            .booking {
                background: linear-gradient(145deg, #4ecdc4, #44a08d);
                border: 1px solid rgba(78, 205, 196, 0.6);
                border-radius: 8px;
                padding: 4px 8px;
                margin: 3px 0;
                font-size: 11px;
                font-weight: 600;
                color: #ffffff;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                box-shadow: 0 2px 8px rgba(78, 205, 196, 0.3);
                transition: all 0.2s ease;
            }
            
            .booking:hover {
                transform: translateY(-1px);
                box-shadow: 0 4px 12px rgba(78, 205, 196, 0.4);
            }
            
            .blocked {
                background: linear-gradient(145deg, #4a1a1a, #3a1414);
                border: 1px solid rgba(255, 107, 107, 0.6);
                border-radius: 8px;
                padding: 4px 8px;
                margin: 3px 0;
                font-size: 11px;
                font-weight: 600;
                color: #ff6b6b;
                box-shadow: 0 2px 8px rgba(255, 107, 107, 0.3);
            }
            
            .personal-event {
                border-radius: 8px;
                padding: 4px 8px;
                margin: 3px 0;
                font-size: 11px;
                font-weight: 600;
                color: #ffffff;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
                transition: all 0.2s ease;
            }
            
            .personal-event:hover {
                transform: translateY(-1px);
                filter: brightness(1.1);
            }
            
            .quick-nav {
                display: flex;
                justify-content: center;
                gap: 10px;
                margin: 20px 0;
                flex-wrap: wrap;
            }
            
            .month-btn {
                background: linear-gradient(145deg, #fdfbfe, #f0e8f5);
                color: #7a5a96;
                border: 1px solid rgba(155, 124, 182, 0.3);
                padding: 10px 16px;
                border-radius: 12px;
                cursor: pointer;
                font-size: 12px;
                font-weight: 600;
                transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                backdrop-filter: blur(10px);
            }
            
            .month-btn:hover {
                background: linear-gradient(145deg, #9B59B6, #8E44AD);
                color: #ffffff;
                border-color: rgba(155, 124, 182, 0.6);
                transform: translateY(-2px);
                box-shadow: 0 6px 20px rgba(155, 124, 182, 0.4);
            }
            
            .month-btn.current {
                background: linear-gradient(145deg, #9B59B6, #7a5a96);
                color: #ffffff;
                border-color: #BFA8D1;
                box-shadow: 0 4px 15px rgba(155, 124, 182, 0.5);
                transform: translateY(-1px);
            }
            
            .bottom-nav {
                position: fixed;
                bottom: 0;
                left: 0;
                right: 0;
                background: linear-gradient(180deg, rgba(255, 255, 255, 0.95) 0%, rgba(249, 242, 245, 0.95) 100%);
                border-top: 2px solid rgba(155, 124, 182, 0.4);
                display: flex;
                justify-content: space-around;
                padding: 20px 16px;
                box-shadow: 0 -8px 32px rgba(142, 68, 173, 0.2);
                backdrop-filter: blur(20px);
                z-index: 100;
            }
            
            .bottom-nav-btn {
                background: transparent;
                border: 1px solid transparent;
                color: #6b5b7a;
                text-align: center;
                cursor: pointer;
                padding: 12px 8px;
                border-radius: 16px;
                transition: all 0.3s ease;
                font-size: 0.85em;
                font-weight: 500;
                min-width: 70px;
                min-height: 70px;
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                gap: 6px;
                position: relative;
            }
            
            .bottom-nav-btn:hover {
                background: rgba(155, 124, 182, 0.1);
                color: #7a5a96;
                border-color: rgba(155, 124, 182, 0.3);
                transform: translateY(-2px);
            }
            
            .bottom-nav-btn.active {
                color: #7a5a96;
                background: rgba(155, 124, 182, 0.15);
                border-color: rgba(155, 124, 182, 0.4);
                box-shadow: 0 4px 20px rgba(155, 124, 182, 0.2);
            }
            
            @media (max-width: 768px) {
                body { 
                    padding: 16px; 
                    padding-bottom: 120px; 
                    font-size: 16px;
                }
                .container { 
                    border-radius: 20px; 
                    margin: 0;
                    max-width: 100%;
                }
                .header { 
                    padding: 24px 20px; 
                    flex-direction: column; 
                    gap: 20px; 
                }
                .header h1 {
                    font-size: 1.8rem;
                }
                .calendar { 
                    padding: 20px; 
                }
                .day-cell { 
                    min-height: 120px; 
                    padding: 8px; 
                    font-size: 14px;
                }
                .calendar-grid { 
                    gap: 2px; 
                }
                .day-header { 
                    padding: 12px 4px; 
                    font-size: 14px; 
                    font-weight: 600;
                }
                .day-number {
                    font-size: 18px;
                    font-weight: 700;
                }
                .booking, .blocked { 
                    font-size: 11px; 
                    padding: 6px;
                    margin: 2px 0;
                }
                .nav-btn { 
                    padding: 14px 18px; 
                    font-size: 16px; 
                    min-width: 100px;
                }
                .month-btn { 
                    padding: 12px 16px; 
                    font-size: 14px; 
                    margin: 2px;
                }
                .bottom-nav-btn {
                    min-width: 60px;
                    min-height: 60px;
                    font-size: 0.8em;
                    padding: 8px 6px;
                }
            }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <button class="nav-btn" ${!canGoPrev ? 'disabled' : ''} onclick="changeMonth(-1)">← Previous</button>
                <h1>📅 ${monthName}</h1>
                <button class="nav-btn" ${!canGoNext ? 'disabled' : ''} onclick="changeMonth(1)">Next →</button>
            </div>
            
            <div class="calendar">
                <div class="quick-nav">
                    ${generateQuickNavButtons(year, month)}
                </div>
                
                <div class="calendar-grid">
                    <div class="day-header">Sun</div>
                    <div class="day-header">Mon</div>
                    <div class="day-header">Tue</div>
                    <div class="day-header">Wed</div>
                    <div class="day-header">Thu</div>
                    <div class="day-header">Fri</div>
                    <div class="day-header">Sat</div>
                    
                    ${generateCalendarDays(year, month, monthBookings, blockedTimes)}
                </div>
            </div>
        </div>
        
        <div class="bottom-nav">
            <button class="bottom-nav-btn" onclick="window.location.href='/admin'">
                <div>📊</div>
                <div>Today</div>
            </button>
            <button class="bottom-nav-btn active">
                <div>📅</div>
                <div>Calendar</div>
            </button>
            <button class="bottom-nav-btn" onclick="window.location.href='/admin#analytics'">
                <div>📈</div>
                <div>Analytics</div>
            </button>

        </div>
        
        <script>
            function changeMonth(direction) {
                const currentUrl = new URL(window.location);
                const currentMonth = parseInt(currentUrl.searchParams.get('month') || '${month}');
                const currentYear = parseInt(currentUrl.searchParams.get('year') || '${year}');
                
                let newMonth = currentMonth + direction;
                let newYear = currentYear;
                
                if (newMonth < 0) {
                    newMonth = 11;
                    newYear--;
                } else if (newMonth > 11) {
                    newMonth = 0;
                    newYear++;
                }
                
                window.location.href = '/calendar?month=' + newMonth + '&year=' + newYear;
            }
            
            function goToMonth(month, year) {
                window.location.href = '/calendar?month=' + month + '&year=' + year;
            }
            
            function manageDay(date) {
                window.location.href = '/manage-day?date=' + date;
            }
        </script>
    </body>
    </html>`;
}

// Generate quick navigation buttons
function generateQuickNavButtons(currentYear, currentMonth) {
    const now = new Date();
    const buttons = [];

    for (let i = -1; i <= 6; i++) {
        const date = new Date(now.getFullYear(), now.getMonth() + i);
        const monthName = date.toLocaleDateString('en-US', { month: 'short' });
        const year = date.getFullYear();
        const month = date.getMonth();
        const isActive = year === currentYear && month === currentMonth;

        buttons.push(`
            <button class="month-btn ${isActive ? 'current' : ''}" 
                    onclick="goToMonth(${month}, ${year})">
                ${monthName} ${year}
            </button>
        `);
    }

    return buttons.join('');
}

// Generate calendar days
function generateCalendarDays(year, month, bookings, blockedTimes) {
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const startDate = new Date(firstDay);
    startDate.setDate(startDate.getDate() - firstDay.getDay());

    const days = [];
    const today = new Date().toDateString();

    for (let i = 0; i < 42; i++) {
        const currentDate = new Date(startDate);
        currentDate.setDate(startDate.getDate() + i);

        const dateStr = currentDate.toISOString().split('T')[0];
        const dayNumber = currentDate.getDate();
        const isCurrentMonth = currentDate.getMonth() === month;
        const isToday = currentDate.toDateString() === today;

        // Get bookings for this day (only main bookings)
        const dayBookings = bookings.filter(b =>
            b.date.split('T')[0] === dateStr && b.isMainBooking === true
        );

        // Sort bookings by appointment time for calendar display
        dayBookings.sort((a, b) => {
            const timeA = convertTo24Hour(a.time);
            const timeB = convertTo24Hour(b.time);
            return timeA.localeCompare(timeB);
        });

        // Get blocked times for this day
        const dayBlocked = blockedTimes.filter(bt => bt.date === dateStr);

        // Get personal events for this day
        const personalEvents = readPersonalEventsFile();
        const dayEvents = personalEvents.filter(e => e.date === dateStr);

        // Check if entire day is blocked - either by personal event OR manual blocking
        const hasEntireDayPersonalEvent = dayEvents.some(event => event.duration >= 720);

        // Check if ALL time slots are manually blocked
        const allTimeSlots = [
            '9:00 AM', '10:00 AM', '11:00 AM', '12:00 PM', '1:00 PM', '2:00 PM',
            '3:00 PM', '4:00 PM', '5:00 PM', '6:00 PM', '7:00 PM', '8:00 PM', '9:00 PM'
        ];

        const allSlotsBlocked = allTimeSlots.every(slot =>
            dayBlocked.some(bt => bt.time === slot) ||
            dayBookings.some(b => b.time === slot)
        );

        const isEntireDayBlocked = hasEntireDayPersonalEvent || allSlotsBlocked;

        let cellClass = 'day-cell';
        if (!isCurrentMonth) cellClass += ' other-month';
        if (isToday) cellClass += ' today';
        if (isEntireDayBlocked) cellClass += ' entire-day-blocked';

        const bookingItems = dayBookings.map(booking =>
            `<div class="booking" title="${booking.customerName} - ${booking.services.map(s => s.name).join(', ')} - ${booking.time}">${booking.time} ${booking.customerName}</div>`
        ).join('');

        let blockedItems = '';
        if (isEntireDayBlocked) {
            const blockReason = hasEntireDayPersonalEvent ? 'PERSONAL EVENT' : 'MANUALLY BLOCKED';
            blockedItems = `<div class="blocked" style="background: #dc3545; color: white; font-weight: bold;">🚫 ENTIRE DAY BLOCKED (${blockReason})</div>`;
        } else if (dayBlocked.length > 0) {
            blockedItems = `<div class="blocked">🚫 ${dayBlocked.length} blocked</div>`;
        }

        const eventItems = dayEvents.map(event => {
            const isEntireDay = event.duration >= 720;
            const displayTime = isEntireDay ? 'ALL DAY' : event.time;
            const displayTitle = isEntireDay ? `🚫 ${event.title}` : event.title;
            const eventColor = isEntireDay ? '#dc3545' : event.color; // Red for entire day events

            return `<div class="personal-event" style="background-color: ${eventColor}; color: white; font-size: 10px; padding: 1px 3px; margin: 1px 0; border-radius: 3px; font-weight: ${isEntireDay ? 'bold' : 'normal'};" title="${event.title} - ${isEntireDay ? 'Entire Day Blocked' : event.time}">${displayTime} ${displayTitle}</div>`
        }).join('');

        days.push(`
            <div class="${cellClass}" onclick="manageDay('${dateStr}')">
                <div class="day-number">${dayNumber}</div>
                ${bookingItems}
                ${eventItems}
                ${blockedItems}
            </div>
        `);
    }

    return days.join('');
}

// Helper function to convert 12-hour time to 24-hour for sorting
function convertTo24Hour(time12h) {
    const [time, modifier] = time12h.split(' ');
    let [hours, minutes] = time.split(':');
    hours = parseInt(hours, 10);

    if (modifier === 'AM') {
        if (hours === 12) {
            hours = 0; // 12 AM becomes 00:xx
        }
    } else { // PM
        if (hours !== 12) {
            hours += 12; // 1 PM becomes 13:xx, 2 PM becomes 14:xx, etc.
        }
        // 12 PM stays 12:xx
    }

    return `${hours.toString().padStart(2, '0')}:${minutes}`;
}

// Generate manage day HTML
function generateManageDayHTML(date, bookings, blockedTimes) {
    // Parse date safely to avoid timezone offset issues
    const [year, month, day] = date.split('-').map(num => parseInt(num, 10));
    const targetDate = new Date(year, month - 1, day); // month is 0-indexed
    const dateStr = targetDate.toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });

    // Get bookings for this day
    const dayBookings = bookings.filter(b => formatDateSafe(b.date) === date);
    const mainBookings = dayBookings.filter(b => b.isMainBooking === true);

    // Sort bookings by appointment time (not creation time)
    mainBookings.sort((a, b) => {
        const timeA = convertTo24Hour(a.time);
        const timeB = convertTo24Hour(b.time);
        return timeA.localeCompare(timeB);
    });

    // Get blocked times
    const dayBlocked = blockedTimes.filter(bt => bt.date === date);

    // Get personal events
    const personalEvents = readPersonalEventsFile();
    const dayEvents = personalEvents.filter(e => e.date === date);

    // Check if there's an entire day personal event (12+ hours)
    const hasEntireDayPersonalEvent = dayEvents.some(event => event.duration >= 720);

    const allTimes = [
        '9:00 AM', '10:00 AM', '11:00 AM', '12:00 PM', '1:00 PM', '2:00 PM',
        '3:00 PM', '4:00 PM', '5:00 PM', '6:00 PM', '7:00 PM', '8:00 PM', '9:00 PM'
    ];

    return `
    <!DOCTYPE html>
    <html>
    <head>
        <title>Manage ${dateStr} - Beauty With Mare</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
            @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap');
            
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { 
                font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                background: linear-gradient(135deg, #8E44AD 0%, #9B59B6 50%, #663399 100%);
                min-height: 100vh;
                padding: 16px;
                padding-bottom: 140px;
                color: #ffffff;
                font-weight: 400;
            }
            
            .container {
                max-width: 1400px;
                margin: 0 auto;
                background: linear-gradient(145deg, #9B59B6, #8E44AD);
                border-radius: 28px;
                box-shadow: 0 30px 60px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.05);
                overflow: hidden;
                backdrop-filter: blur(20px);
            }
            
            .header {
                background: linear-gradient(135deg, #9B59B6 0%, #BFA8D1 30%, #9B59B6 70%, #7a5a96 100%);
                color: #ffffff;
                padding: 40px;
                text-align: center;
                position: relative;
                overflow: hidden;
            }
            
            .header::before {
                content: '';
                position: absolute;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: linear-gradient(45deg, transparent 30%, rgba(255,255,255,0.1) 50%, transparent 70%);
                animation: shimmer 4s infinite;
            }
            
            @keyframes shimmer {
                0% { transform: translateX(-100%); }
                100% { transform: translateX(100%); }
            }
            
            .header h1 {
                font-size: 2.2em;
                font-weight: 800;
                letter-spacing: -0.02em;
                position: relative;
                z-index: 1;
                text-shadow: 0 2px 4px rgba(0,0,0,0.1);
            }
            
            .content {
                padding: 40px;
                background: transparent;
            }
            
            .section {
                margin-bottom: 32px;
                padding: 28px;
                background: linear-gradient(145deg, #fdfbfe, #f0e8f5);
                border-radius: 20px;
                border: 1px solid rgba(255, 255, 255, 0.08);
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
                transition: all 0.3s ease;
            }
            
            .section:hover {
                border-color: rgba(212, 175, 55, 0.2);
                box-shadow: 0 12px 40px rgba(0, 0, 0, 0.4);
            }
            
            .booking-item {
                background: linear-gradient(145deg, #c4b1d6, #9b7cb6);
                padding: 24px;
                margin: 20px 0;
                border-radius: 16px;
                border-left: 4px solid #9B59B6;
                border: 1px solid rgba(255, 255, 255, 0.05);
                box-shadow: 0 8px 25px rgba(0, 0, 0, 0.3);
                transition: all 0.3s ease;
            }
            
            .booking-item:hover {
                transform: translateY(-2px);
                box-shadow: 0 12px 35px rgba(0, 0, 0, 0.4);
                border-color: rgba(212, 175, 55, 0.3);
            }
            
            .booking-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 16px;
            }
            
            .booking-time {
                font-weight: 700;
                color: #BFA8D1;
                font-size: 1.3em;
                text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
            }
            
            .booking-details {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
                gap: 20px;
                margin-top: 20px;
            }
            
            .detail-item {
                padding: 16px;
                background: linear-gradient(145deg, #fdfbfe, #f0e8f5);
                border-radius: 12px;
                border: 1px solid rgba(255, 255, 255, 0.05);
                transition: all 0.2s ease;
            }
            
            .detail-item:hover {
                border-color: rgba(212, 175, 55, 0.2);
                transform: translateY(-1px);
            }
            
            .detail-label {
                font-size: 11px;
                color: #6b46c1;
                text-transform: uppercase;
                font-weight: 600;
                letter-spacing: 0.5px;
                margin-bottom: 8px;
            }
            
            .detail-value {
                font-size: 15px;
                color: #2d1b3d;
                font-weight: 500;
            }
            
            .phone-link {
                color: #6b46c1;
                text-decoration: none;
                font-weight: 600;
                transition: all 0.2s ease;
            }
            
            .phone-link:hover {
                text-decoration: underline;
                color: #4c1d95;
            }
            
            .time-slots {
                display: grid;
                grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
                gap: 16px;
                margin: 24px 0;
            }
            
            .time-slot {
                padding: 18px 12px;
                border: 2px solid rgba(255, 255, 255, 0.1);
                border-radius: 12px;
                text-align: center;
                cursor: pointer;
                transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                font-weight: 600;
                background: linear-gradient(145deg, #fdfbfe, #f0e8f5);
                color: #ffffff;
                font-size: 14px;
            }
            
            .time-slot.available {
                background: linear-gradient(145deg, #1a4a3a, #0f3028);
                border-color: #4caf50;
                color: #4caf50;
                box-shadow: 0 4px 15px rgba(76, 175, 80, 0.2);
            }
            
            .time-slot.booked {
                background: linear-gradient(145deg, #4a3a1a, #3a2810);
                border-color: #BFA8D1;
                color: #ffffff;
                cursor: not-allowed;
                box-shadow: 0 4px 15px rgba(212, 175, 55, 0.2);
            }
            
            .time-slot.blocked {
                background: linear-gradient(145deg, #4a1a1a, #3a1414);
                border-color: #ff6b6b;
                color: #ff6b6b;
                box-shadow: 0 4px 15px rgba(255, 107, 107, 0.2);
            }
            
            .time-slot:hover:not(.booked) {
                transform: translateY(-3px);
                box-shadow: 0 8px 25px rgba(0, 0, 0, 0.3);
                border-color: rgba(212, 175, 55, 0.4);
            }
            
            .action-btn {
                background: linear-gradient(145deg, #9B59B6, #7a5a96);
                color: #ffffff;
                border: 1px solid rgba(212, 175, 55, 0.3);
                padding: 14px 24px;
                border-radius: 12px;
                cursor: pointer;
                font-size: 16px;
                font-weight: 600;
                margin: 12px 8px;
                transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                text-decoration: none;
                display: inline-block;
            }
            
            .action-btn:hover {
                background: linear-gradient(145deg, #BFA8D1, #9B59B6);
                color: #ffffff;
                transform: translateY(-3px);
                box-shadow: 0 8px 25px rgba(212, 175, 55, 0.4);
            }
            
            .action-btn.danger {
                background: #f44336;
            }
            
            .action-btn.danger:hover {
                background: #d32f2f;
            }
            
            .delete-btn {
                background: linear-gradient(145deg, #4a1a1a, #3a1414);
                color: #ff6b6b;
                border: 1px solid rgba(255, 107, 107, 0.3);
                padding: 10px 14px;
                border-radius: 12px;
                cursor: pointer;
                font-size: 14px;
                font-weight: 600;
                transition: all 0.3s ease;
            }
            
            .delete-btn:hover {
                background: linear-gradient(145deg, #6a2424, #5a1e1e);
                color: #ffffff;
                border-color: rgba(255, 107, 107, 0.6);
                transform: translateY(-2px);
                box-shadow: 0 4px 15px rgba(255, 107, 107, 0.3);
            }
            
            .bottom-nav {
                position: fixed;
                bottom: 0;
                left: 0;
                right: 0;
                background: linear-gradient(180deg, rgba(255, 255, 255, 0.95) 0%, rgba(249, 242, 245, 0.95) 100%);
                border-top: 2px solid rgba(155, 124, 182, 0.4);
                display: flex;
                justify-content: space-around;
                padding: 20px 16px;
                box-shadow: 0 -8px 32px rgba(142, 68, 173, 0.2);
                backdrop-filter: blur(20px);
                z-index: 100;
            }
            
            .bottom-nav-btn {
                background: transparent;
                border: 1px solid transparent;
                color: #6b5b7a;
                text-align: center;
                cursor: pointer;
                padding: 12px 8px;
                border-radius: 16px;
                transition: all 0.3s ease;
                font-size: 0.85em;
                font-weight: 500;
                min-width: 70px;
                min-height: 70px;
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                gap: 6px;
                position: relative;
            }
            
            .bottom-nav-btn:hover {
                background: rgba(155, 124, 182, 0.1);
                color: #7a5a96;
                border-color: rgba(155, 124, 182, 0.3);
                transform: translateY(-2px);
            }
            
            .bottom-nav-btn.active {
                color: #7a5a96;
                background: rgba(155, 124, 182, 0.15);
                border-color: rgba(155, 124, 182, 0.4);
                box-shadow: 0 4px 20px rgba(155, 124, 182, 0.2);
            }
            
            @media (max-width: 768px) {
                body { padding: 10px; padding-bottom: 140px; }
                .container { border-radius: 15px; }
                .header { padding: 20px 15px; }
                .content { padding: 20px 15px; }
                .booking-header { flex-direction: column; align-items: flex-start; gap: 10px; }
                .booking-details { grid-template-columns: 1fr; }
                .time-slots { grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); }
                .time-slot { padding: 12px 8px; font-size: 14px; }
                .action-btn { width: 100%; margin: 5px 0; }
            }

            /* Premium Modal Styles */
            .premium-modal-overlay {
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0, 0, 0, 0.8);
                backdrop-filter: blur(10px);
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 9999;
                animation: fadeIn 0.3s ease;
            }

            .premium-modal {
                background: linear-gradient(145deg, #fdfbfe, #f0e8f5);
                border-radius: 24px;
                border: 1px solid rgba(212, 175, 55, 0.3);
                box-shadow: 0 20px 60px rgba(0, 0, 0, 0.8);
                max-width: 400px;
                width: 90%;
                max-height: 90vh;
                overflow: hidden;
                animation: slideIn 0.3s ease;
            }

            .premium-modal.success { border-color: rgba(76, 175, 80, 0.4); }
            .premium-modal.error { border-color: rgba(255, 107, 107, 0.4); }

            .premium-modal-header {
                padding: 24px 24px 0 24px;
                text-align: center;
            }

            .premium-modal-header h3 {
                color: #BFA8D1;
                font-size: 1.4em;
                font-weight: 700;
                margin: 0;
            }

            .premium-modal.success .premium-modal-header h3 { color: #4caf50; }
            .premium-modal.error .premium-modal-header h3 { color: #ff6b6b; }

            .premium-modal-body {
                padding: 20px 24px;
                text-align: center;
                color: #ffffff;
                line-height: 1.5;
            }

            .premium-modal-actions {
                padding: 0 24px 24px 24px;
                display: flex;
                gap: 12px;
                justify-content: center;
            }

            .premium-btn-cancel, .premium-btn-delete, .premium-btn-ok {
                padding: 14px 24px;
                border-radius: 12px;
                font-size: 16px;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.3s ease;
                border: none;
                min-width: 100px;
            }

            .premium-btn-cancel {
                background: linear-gradient(145deg, #3a3a3a, #2e2e2e);
                color: #ffffff;
                border: 1px solid rgba(255, 255, 255, 0.2);
            }
            .premium-btn-cancel:hover {
                background: linear-gradient(145deg, #4a4a4a, #3e3e3e);
                transform: translateY(-2px);
            }

            .premium-btn-delete {
                background: linear-gradient(145deg, #ff6b6b, #e53e3e);
                color: #ffffff;
            }
            .premium-btn-delete:hover {
                background: linear-gradient(145deg, #ff8a8a, #ff6b6b);
                transform: translateY(-2px);
                box-shadow: 0 8px 25px rgba(255, 107, 107, 0.4);
            }

            .premium-btn-ok {
                background: linear-gradient(145deg, #9B59B6, #7a5a96);
                color: #ffffff;
            }
            .premium-btn-ok:hover {
                background: linear-gradient(145deg, #f5d76e, #d4af37);
                transform: translateY(-2px);
                box-shadow: 0 8px 25px rgba(212, 175, 55, 0.4);
            }

            @keyframes fadeIn {
                from { opacity: 0; }
                to { opacity: 1; }
            }
            @keyframes slideIn {
                from { opacity: 0; transform: translateY(-50px) scale(0.9); }
                to { opacity: 1; transform: translateY(0) scale(1); }
            }

            @media (max-width: 768px) {
                .premium-modal { width: 95%; margin: 20px; }
                .premium-modal-actions { flex-direction: column; }
                .premium-btn-cancel, .premium-btn-delete, .premium-btn-ok { width: 100%; min-height: 50px; }
            }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>📅 Manage ${dateStr}</h1>
            </div>
            
            <div class="content">
                <!-- Navigation Section -->
                <div style="text-align: center; margin-bottom: 25px; padding: 20px; background: #f8f9fa; border-radius: 15px;">
                    <button onclick="window.location.href='/calendar'" 
                            style="background: #9B59B6; color: white; border: none; padding: 15px 30px; border-radius: 10px; cursor: pointer; font-size: 16px; font-weight: bold; margin: 0 10px; transition: all 0.3s ease; box-shadow: 0 4px 8px rgba(0,0,0,0.1);"
                            onmouseover="this.style.background='#8B47A1'; this.style.transform='translateY(-2px)'"
                            onmouseout="this.style.background='#9B59B6'; this.style.transform='translateY(0)'">
                        ← Back to Calendar
                    </button>
                    <button onclick="window.location.href='/admin'" 
                            style="background: #8B47A1; color: white; border: none; padding: 15px 30px; border-radius: 10px; cursor: pointer; font-size: 16px; font-weight: bold; margin: 0 10px; transition: all 0.3s ease; box-shadow: 0 4px 8px rgba(0,0,0,0.1);"
                            onmouseover="this.style.background='#7A3F91'; this.style.transform='translateY(-2px)'"
                            onmouseout="this.style.background='#8B47A1'; this.style.transform='translateY(0)'">
                        📊 Today View
                    </button>
                    <button onclick="openManualBookingModalForDate('${date}')" 
                            style="background: #9B59B6; color: white; border: none; padding: 15px 30px; border-radius: 10px; cursor: pointer; font-size: 16px; font-weight: bold; margin: 0 10px; transition: all 0.3s ease; box-shadow: 0 4px 8px rgba(0,0,0,0.1);"
                            onmouseover="this.style.background='#8B47A1'; this.style.transform='translateY(-2px)'"
                            onmouseout="this.style.background='#9B59B6'; this.style.transform='translateY(0)'">
                        📝 Manual Booking
                    </button>
                </div>
                
                <div class="section">
                    <h2>Personal Events (${dayEvents.length})</h2>
                    <div style="text-align: center; margin-bottom: 15px;">
                        <button onclick="openAddEventModal('${date}')" 
                                style="background: #9B59B6; color: white; border: none; padding: 10px 20px; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: bold;">
                            + Add Personal Event
                        </button>
                    </div>
                    ${dayEvents.length === 0 ?
            '<p>No personal events for this day.</p>' :
            dayEvents.map(event => {
                const isEntireDay = event.duration >= 720;
                // Format duration nicely
                const formatDuration = (minutes) => {
                    if (minutes >= 720) return 'Full Day';
                    if (minutes >= 60 && minutes % 60 === 0) {
                        const hours = minutes / 60;
                        return hours === 1 ? '1 hour' : `${hours} hours`;
                    }
                    return `${minutes} min`;
                };
                const displayTime = isEntireDay ? '🚫 ENTIRE DAY BLOCKED' : `${event.time} (${formatDuration(event.duration)})`;
                const borderColor = isEntireDay ? '#f44336' : event.color;

                return `
                            <div style="background: white; padding: 15px; margin: 10px 0; border-radius: 10px; border-left: 4px solid ${borderColor}; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
                                <div style="display: flex; justify-content: space-between; align-items: center;">
                                    <div>
                                        <div style="font-weight: bold; color: #333; font-size: 1.1em;">${displayTime}</div>
                                        <div style="color: ${isEntireDay ? '#f44336' : '#667eea'}; font-weight: bold; margin-top: 3px;">${event.title}</div>
                                        ${event.description ? `<div style="color: #666; margin-top: 5px;">${event.description}</div>` : ''}
                                        ${isEntireDay ? `<div style="color: #f44336; font-size: 0.9em; margin-top: 5px;"><strong>⚠️ All booking slots blocked for this day</strong></div>` : ''}
                                    </div>
                                    <button onclick="deletePersonalEvent('${event.id}')" 
                                            style="background: #f44336; color: white; border: none; padding: 6px 10px; border-radius: 4px; cursor: pointer; font-size: 12px;">
                                        🗑️ Delete  
                                    </button>
                                </div>
                            </div>
                        `}).join('')
        }
                </div>
                
                <div class="section">
                    <h2>Appointments (${mainBookings.length})</h2>
                    ${mainBookings.length === 0 ?
            '<p>No appointments scheduled for this day.</p>' :
            mainBookings.map(booking => `
                            <div class="booking-item" style="${booking.refundStatus !== 'none' ? 'border-left-color: #ffc107; background-color: #fff8e1;' : ''}">
                                <div class="booking-header">
                                    <div class="booking-time">${booking.time}</div>
                                    <div style="display: flex; gap: 10px; align-items: center;">
                                        ${booking.refundStatus && booking.refundStatus !== 'none' ?
                    `<span style="background: #ffc107; color: #000; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: bold;">
                                                ${booking.refundStatus.toUpperCase()} REFUND
                                            </span>` : ''}
                                    <button class="delete-btn" onclick="deleteAppointment('${booking.id}')">🗑️ Delete</button>
                                </div>
                                </div>
                                
                                <!-- DEPOSIT & BALANCE INFO (PROMINENT) -->
                                ${booking.paymentType === 'deposit' ? `
                                <div style="background: #e3f2fd; border: 2px solid #2196f3; border-radius: 8px; padding: 15px; margin: 10px 0; font-weight: bold;">
                                    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; text-align: center;">
                                        <div>
                                            <div style="font-size: 12px; color: #1976d2;">SERVICE TOTAL</div>
                                            <div style="font-size: 18px; color: #000;">$${booking.totalAmount.toFixed(2)}</div>
                                        </div>
                                        <div>
                                            <div style="font-size: 12px; color: #4caf50;">DEPOSIT PAID</div>
                                            <div style="font-size: 18px; color: #2e7d32;">$${booking.depositPaid.toFixed(2)}</div>
                                        </div>
                                        <div>
                                            <div style="font-size: 12px; color: ${booking.remainingBalance > 0 ? '#f44336' : '#4caf50'};">BALANCE DUE</div>
                                            <div style="font-size: 18px; color: ${booking.remainingBalance > 0 ? '#d32f2f' : '#2e7d32'};">$${booking.remainingBalance.toFixed(2)}</div>
                                        </div>
                                    </div>
                                    ${booking.refundStatus === 'none' && booking.status !== 'CANCELLED' ? `
                                    <div style="margin-top: 15px; text-align: center;">
                                        <button onclick="showRefundModal('${booking.id}', '${booking.customerName}', ${booking.depositPaid})" 
                                                style="background: #ff9800; color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: bold;">
                                            💸 Process Refund
                                        </button>
                                    </div>` : ''}
                                </div>` : ''}
                                
                                <div class="booking-details">
                                    <div class="detail-item">
                                        <div class="detail-label">Customer</div>
                                        <div class="detail-value">${booking.customerName}</div>
                                    </div>
                                    <div class="detail-item">
                                        <div class="detail-label">Phone</div>
                                        <div class="detail-value">
                                            <a href="tel:${booking.customerPhone}" class="phone-link">${booking.customerPhone}</a>
                                        </div>
                                    </div>
                                    <div class="detail-item">
                                        <div class="detail-label">Email</div>
                                        <div class="detail-value">${booking.customerEmail}</div>
                                    </div>
                                    <div class="detail-item">
                                        <div class="detail-label">Service</div>
                                        <div class="detail-value">${booking.services.map(s => s.name).join(', ')}</div>
                                    </div>
                                    <div class="detail-item">
                                        <div class="detail-label">Payment Method</div>
                                        <div class="detail-value">${booking.paymentMethod || 'Square'}</div>
                                    </div>
                                    ${booking.notes ? `
                                    <div class="detail-item">
                                        <div class="detail-label">Notes</div>
                                        <div class="detail-value">${booking.notes}</div>
                                    </div>
                                    ` : ''}
                                    ${booking.refundStatus && booking.refundStatus !== 'none' ? `
                                    <div class="detail-item">
                                        <div class="detail-label">Refund Info</div>
                                        <div class="detail-value">
                                            ${booking.refundStatus.toUpperCase()}: $${(booking.refundAmount || 0).toFixed(2)}<br>
                                            <small style="color: #666;">${booking.refundReason || 'No reason provided'}</small>
                                        </div>
                                    </div>
                                    ` : ''}
                                </div>
                            </div>
                        `).join('')
        }
                </div>
                
                <div class="section">
                    <h2>Manage Time Slots</h2>
                    <div style="text-align: center; margin-bottom: 20px;">
                        <button class="action-btn danger" onclick="blockEntireDay()">Block Entire Day</button>
                        <button class="action-btn success" onclick="unblockEntireDay()">Unblock Entire Day</button>
                    </div>
                    <div class="time-slots">
                        ${allTimes.map(time => {
            // Check ALL bookings (including blocked slots from multi-hour bookings)
            const isBooked = dayBookings.some(b => b.time === time);
            const isBlocked = dayBlocked.some(b => b.time === time);
            // Check for entire day personal events - if day is entirely blocked, all slots should show as blocked
            const status = hasEntireDayPersonalEvent ? 'blocked' : (isBooked ? 'booked' : (isBlocked ? 'blocked' : 'available'));

            return `
                                <div class="time-slot ${status}" onclick="toggleTimeSlot('${time}', '${status}')">
                                    ${time}
                                    <br><small>${status.toUpperCase()}</small>
                                </div>
                            `;
        }).join('')}
                    </div>
                </div>
            </div>
        </div>
        
        <div class="bottom-nav">
            <button class="bottom-nav-btn" onclick="window.location.href='/admin'">
                <div>📊</div>
                <div>Today</div>
            </button>
            <button class="bottom-nav-btn active" onclick="window.location.href='/calendar'">
                <div>📅</div>
                <div>Calendar</div>
            </button>
            <button class="bottom-nav-btn" onclick="window.location.href='/admin#analytics'">
                <div>📈</div>
                <div>Analytics</div>
            </button>

        </div>
        
        <!-- Refund Modal -->
        <div id="refundModal" style="display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 1001; align-items: center; justify-content: center;">
            <div style="background: white; border-radius: 15px; padding: 30px; max-width: 500px; width: 90%; max-height: 80vh; overflow-y: auto;">
                <h3 style="margin-bottom: 20px; color: #333;">💸 Process Refund</h3>
                <div id="refundInfo" style="background: #f8f9fa; padding: 15px; border-radius: 10px; margin-bottom: 20px;">
                    <!-- Customer and booking info will be populated here -->
                </div>
                
                <!-- Late Policy Notice -->
                <div style="background: #fff3cd; border: 1px solid #ffeaa7; padding: 15px; border-radius: 10px; margin-bottom: 20px;">
                    <h4 style="margin: 0 0 10px 0; color: #856404;">⏰ Late & Cancellation Policy</h4>
                    <div style="font-size: 0.9em; color: #856404; line-height: 1.4;">
                        <p style="margin: 5px 0;"><strong>📅 48+ hours notice:</strong> Full deposit refund</p>
                        <p style="margin: 5px 0;"><strong>📅 24-48 hours notice:</strong> 50% deposit refund</p>
                        <p style="margin: 5px 0;"><strong>📅 Less than 24 hours:</strong> Deposit forfeited</p>
                        <p style="margin: 5px 0; color: #dc3545;"><strong>⏰ 10+ minutes late:</strong> Forfeit deposit + reschedule required</p>
                    </div>
                </div>
                
                <form id="refundForm">
                    <div style="margin-bottom: 15px;">
                        <label style="display: block; margin-bottom: 5px; font-weight: bold;">Refund Type</label>
                        <select id="refundType" required style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 8px;">
                            <option value="">Select refund type...</option>
                            <option value="full">Full Refund (48+ hours notice)</option>
                            <option value="partial">50% Refund (24-48 hours notice)</option>
                            <option value="none">No Refund (Late/No-show)</option>
                        </select>
                    </div>
                    <div style="margin-bottom: 20px;">
                        <label style="display: block; margin-bottom: 5px; font-weight: bold;">Reason (Optional)</label>
                        <textarea id="refundReason" rows="3" 
                                  style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 8px; resize: vertical;"
                                  placeholder="e.g., Customer called 2 days ahead, Family emergency, etc."></textarea>
                    </div>
                    <div style="text-align: center;">
                        <button type="submit" 
                                style="background: #ff9800; color: white; border: none; padding: 12px 25px; border-radius: 8px; cursor: pointer; margin-right: 10px; font-weight: bold;">
                            Process Refund
                        </button>
                        <button type="button" onclick="closeRefundModal()" 
                                style="background: #666; color: white; border: none; padding: 12px 25px; border-radius: 8px; cursor: pointer; font-weight: bold;">
                            Cancel
                        </button>
                    </div>
                </form>
            </div>
        </div>

        <!-- Add Personal Event Modal -->
        <div id="addEventModal" style="display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 1000; align-items: center; justify-content: center;">
            <div style="background: white; border-radius: 15px; padding: 30px; max-width: 500px; width: 90%; max-height: 80vh; overflow-y: auto;">
                <h3 style="margin-bottom: 20px; color: #333;">✨ Add Personal Event</h3>
                <form id="addEventForm">
                    <div style="margin-bottom: 15px;">
                        <label style="display: block; margin-bottom: 5px; font-weight: bold;">Event Title *</label>
                        <input type="text" id="eventTitle" required 
                               style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 8px;"
                               placeholder="e.g., Birthday Party, Doctor Appointment">
                    </div>
                                        <div style="margin-bottom: 15px;">
                        <label style="display: block; margin-bottom: 5px; font-weight: bold;">Start Time</label>
                        <select id="eventTime" 
                                style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 8px;">
                            <option value="">Loading available times...</option>
                        </select>
                        <small id="timeNote" style="color: #666; font-size: 0.9em; margin-top: 5px; display: none;">
                            Start time not needed when blocking entire day
                        </small>
                        <small id="personalEventTimeHelp" style="color: #666; font-size: 0.9em; margin-top: 5px; display: block;">
                            Only showing times that don't conflict with existing bookings
                        </small>
                    </div>
                                            <div style="margin-bottom: 15px;">
                        <label style="display: block; margin-bottom: 5px; font-weight: bold;">Duration</label>
                        <select id="eventDuration" onchange="loadAvailableTimesForPersonalEvent(window.currentPersonalEventDate)"
                                style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 8px;">
                            <option value="60" selected>1 hour</option>
                            <option value="120">2 hours</option>
                            <option value="180">3 hours</option>
                            <option value="240">4 hours</option>
                            <option value="300">5 hours</option>
                            <option value="360">6 hours</option>
                            <option value="720">Block Entire Day (12 hours)</option>
                        </select>
                    </div>
                    <div style="margin-bottom: 15px;">
                        <label style="display: block; margin-bottom: 5px; font-weight: bold;">Description</label>
                        <textarea id="eventDescription" rows="3" 
                                  style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 8px; resize: vertical;"
                                  placeholder="Optional details about the event..."></textarea>
                    </div>
                    <div style="margin-bottom: 20px;">
                        <label style="display: block; margin-bottom: 5px; font-weight: bold;">Color</label>
                        <select id="eventColor" style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 8px;">
                            <option value="#9c27b0">🟣 Purple (Personal)</option>
                            <option value="#2196f3">🔵 Blue (Work)</option>
                            <option value="#4caf50">🟢 Green (Health)</option>
                            <option value="#ff9800">🟠 Orange (Family)</option>
                            <option value="#f44336">🔴 Red (Important)</option>
                            <option value="#607d8b">⚫ Gray (Other)</option>
                        </select>
                    </div>
                    <div style="text-align: center;">
                        <button type="submit" 
                                style="background: #9c27b0; color: white; border: none; padding: 12px 25px; border-radius: 8px; cursor: pointer; margin-right: 10px; font-weight: bold;">
                            Add Event
                        </button>
                        <button type="button" onclick="closeAddEventModal()" 
                                style="background: #666; color: white; border: none; padding: 12px 25px; border-radius: 8px; cursor: pointer; font-weight: bold;">
                            Cancel
                        </button>
                    </div>
                </form>
            </div>
        </div>

        <!-- Manual Booking Modal -->
        <div id="manualBookingModal" style="display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 1000; align-items: center; justify-content: center;">
            <div style="background: white; border-radius: 15px; padding: 30px; max-width: 500px; width: 90%; max-height: 80vh; overflow-y: auto;">
                <h3 style="margin-bottom: 20px; color: #333;">📝 Manual Booking</h3>
                <p style="color: #666; margin-bottom: 20px; font-size: 0.9em;">Add appointments with custom pricing for phone bookings or historical data.</p>
                <form id="manualBookingForm">
                    <div style="margin-bottom: 15px;">
                        <label style="display: block; margin-bottom: 5px; font-weight: bold;">Customer Name *</label>
                        <input type="text" id="manualCustomerName" required 
                               style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 8px;"
                               placeholder="Enter customer name">
                    </div>
                    <div style="margin-bottom: 15px;">
                        <label style="display: block; margin-bottom: 5px; font-weight: bold;">Phone Number *</label>
                        <input type="tel" id="manualCustomerPhone" required 
                               style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 8px;"
                               placeholder="(xxx) xxx-xxxx">
                    </div>
                    <div style="margin-bottom: 15px;">
                        <label style="display: block; margin-bottom: 5px; font-weight: bold;">Email (Optional)</label>
                        <input type="email" id="manualCustomerEmail"
                               style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 8px;"
                               placeholder="customer@email.com">
                    </div>
                    <div style="margin-bottom: 15px;">
                        <label style="display: block; margin-bottom: 5px; font-weight: bold;">Service *</label>
                        <input type="text" id="manualServiceName" required 
                               style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 8px;"
                               placeholder="Enter service name">
                    </div>
                    <div style="margin-bottom: 15px;">
                        <label style="display: block; margin-bottom: 5px; font-weight: bold;">Price ($) *</label>
                        <input type="number" id="manualServicePrice" required min="0" step="0.01"
                               style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 8px;"
                               placeholder="Enter price">
                    </div>
                    <div style="margin-bottom: 15px;">
                        <label style="display: block; margin-bottom: 5px; font-weight: bold;">Duration (minutes) *</label>
                        <select id="manualServiceDuration" style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 8px;">
                            <option value="60" selected>1 hour</option>
                            <option value="120">2 hours</option>
                            <option value="180">3 hours</option>
                        </select>
                    </div>
                    <div style="margin-bottom: 15px;">
                        <label style="display: block; margin-bottom: 5px; font-weight: bold;">Time *</label>
                        <select id="manualBookingTime" required
                                style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 8px;">
                            <option value="">Loading available times...</option>
                        </select>
                        <small style="color: #666; font-size: 0.9em; margin-top: 5px; display: block;">
                            Only showing times that are available for booking
                        </small>
                    </div>
                    <div style="margin-bottom: 15px;">
                        <label style="display: block; margin-bottom: 5px; font-weight: bold;">Payment Status *</label>
                        <select id="manualPaymentStatus" required
                                style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 8px;">
                            <option value="">Select payment status...</option>
                            <option value="paid-full">Paid in Full</option>
                            <option value="paid-deposit">Deposit Paid (50%)</option>
                            <option value="unpaid">Unpaid</option>
                            <option value="comp">Complimentary</option>
                        </select>
                    </div>
                    <div style="margin-bottom: 20px;">
                        <label style="display: block; margin-bottom: 5px; font-weight: bold;">Notes</label>
                        <textarea id="manualAppointmentNotes" rows="3" 
                                  style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 8px; resize: vertical;"
                                  placeholder="Any special notes or details..."></textarea>
                    </div>
                    <div style="text-align: center;">
                        <button type="submit" 
                                style="background: #6b46c1; color: white; border: none; padding: 12px 25px; border-radius: 8px; cursor: pointer; margin-right: 10px; font-weight: bold;">
                            Add Booking
                        </button>
                        <button type="button" onclick="closeManualBookingModal()" 
                                style="background: #666; color: white; border: none; padding: 12px 25px; border-radius: 8px; cursor: pointer; font-weight: bold;">
                            Cancel
                        </button>
                    </div>
                </form>
            </div>
        </div>

        <!-- Quick Appointment Modal -->
        <div id="quickAppointmentModal" style="display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 1000; align-items: center; justify-content: center;">
            <div style="background: white; border-radius: 15px; padding: 30px; max-width: 400px; width: 90%; max-height: 80vh; overflow-y: auto;">
                <h3 style="margin-bottom: 20px; color: #333;">⚡ Quick Appointment</h3>
                <p style="color: #666; margin-bottom: 20px; font-size: 0.9em;">Simple booking for old appointments or walk-ins</p>
                <form id="quickAppointmentForm">
                    <div style="margin-bottom: 15px;">
                        <label style="display: block; margin-bottom: 5px; font-weight: bold;">Customer Name *</label>
                        <input type="text" id="quickCustomerName" required 
                               style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 8px;"
                               placeholder="Enter customer name">
                    </div>
                    <div style="margin-bottom: 15px;">
                        <label style="display: block; margin-bottom: 5px; font-weight: bold;">Phone Number *</label>
                        <input type="tel" id="quickCustomerPhone" required 
                               style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 8px;"
                               placeholder="(xxx) xxx-xxxx">
                    </div>
                    <div style="margin-bottom: 15px;">
                        <label style="display: block; margin-bottom: 5px; font-weight: bold;">Service *</label>
                        <input type="text" id="quickServiceName" required 
                               style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 8px;"
                               placeholder="e.g. Powder Brows, Facial, etc.">
                    </div>
                    <div style="margin-bottom: 15px;">
                        <label style="display: block; margin-bottom: 5px; font-weight: bold;">Price ($) *</label>
                        <input type="number" id="quickServicePrice" required min="0" step="0.01"
                               style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 8px;"
                               placeholder="Enter price">
                    </div>
                    <div style="margin-bottom: 15px;">
                        <label style="display: block; margin-bottom: 5px; font-weight: bold;">Time *</label>
                        <select id="quickBookingTime" required
                                style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 8px;">
                            <option value="">Select time...</option>
                            ${['9:00 AM', '10:00 AM', '11:00 AM', '12:00 PM', '1:00 PM', '2:00 PM',
            '3:00 PM', '4:00 PM', '5:00 PM', '6:00 PM', '7:00 PM', '8:00 PM', '9:00 PM'
        ].map(time => `<option value="${time}">${time}</option>`).join('')}
                        </select>
                    </div>
                    <div style="text-align: center; margin-top: 20px;">
                        <button type="submit" 
                                style="background: #667eea; color: white; border: none; padding: 12px 25px; border-radius: 8px; cursor: pointer; margin-right: 10px; font-weight: bold;">
                            Add Appointment
                        </button>
                        <button type="button" onclick="closeQuickAppointmentModal()" 
                                style="background: #666; color: white; border: none; padding: 12px 25px; border-radius: 8px; cursor: pointer; font-weight: bold;">
                            Cancel
                        </button>
                    </div>
                </form>
            </div>
        </div>
        
        <script>
            function openAddEventModal(date) {
                document.getElementById('addEventModal').style.display = 'flex';
                // Store the date for the personal event
                window.currentPersonalEventDate = date;
                // Load available times for this date
                loadAvailableTimesForPersonalEvent(date);
            }
            
            function closeAddEventModal() {
                document.getElementById('addEventModal').style.display = 'none';
                document.getElementById('addEventForm').reset();
            }
            
            // Handle duration change to show/hide time requirement
            document.getElementById('eventDuration').addEventListener('change', function() {
                const duration = parseInt(this.value);
                const timeSelect = document.getElementById('eventTime');
                const timeNote = document.getElementById('timeNote');
                
                if (duration >= 720) { // Block Entire Day
                    timeSelect.style.opacity = '0.5';
                    timeSelect.required = false;
                    timeNote.style.display = 'block';
                    timeNote.textContent = '⏰ Entire day will be blocked - start time not needed';
                } else {
                    timeSelect.style.opacity = '1';
                    timeSelect.required = true;
                    timeNote.style.display = 'none';
                }
            });

            document.getElementById('addEventForm').addEventListener('submit', async function(e) {
                e.preventDefault();
                
                const duration = parseInt(document.getElementById('eventDuration').value);
                const timeValue = document.getElementById('eventTime').value;
                
                // For entire day blocking, use 9:00 AM as default start time
                const eventData = {
                    date: '${date}',
                    time: duration >= 720 ? '9:00 AM' : timeValue,
                    title: document.getElementById('eventTitle').value,
                    description: document.getElementById('eventDescription').value,
                    color: document.getElementById('eventColor').value,
                    duration: duration
                };

                // Validate required fields
                if (!eventData.title.trim()) {
                    alert('Please enter an event title');
                    return;
                }
                
                if (duration < 720 && !timeValue) {
                    alert('Please select a start time for hourly events');
                    return;
                }
                
                try {
                    const response = await fetch('/api/add-personal-event', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(eventData)
                    });
                    
                    const result = await response.json();
                    if (result.success) {
                        closeAddEventModal();
                        location.reload();
                    } else {
                        alert('Error: ' + result.error);
                    }
                } catch (error) {
                    alert('Error adding event: ' + error.message);
                }
            });
            
            async function deletePersonalEvent(eventId) {
                if (!confirm('Are you sure you want to delete this personal event?')) return;
                
                try {
                    const response = await fetch('/api/delete-personal-event', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ eventId })
                    });
                    
                    const result = await response.json();
                    if (result.success) {
                        location.reload();
                    } else {
                        alert('Error: ' + result.error);
                    }
                } catch (error) {
                    alert('Error deleting event: ' + error.message);
                }
            }
            
            // Manual booking modal functions
            function openManualBookingModalForDate(date) {
                document.getElementById('manualBookingModal').style.display = 'flex';
                // Store the date for the booking
                window.currentBookingDate = date;
                // Load available times for this date
                loadAvailableTimesForManualBooking(date);
            }
            
            // Load available times for manual booking (calendar version)
            async function loadAvailableTimesForManualBooking(date) {
                const timeSelect = document.getElementById('manualBookingTime');
                
                console.log('🔍 Loading available times for calendar manual booking:', date);
                
                // Show loading message
                timeSelect.innerHTML = '<option value="">Loading available times...</option>';
                timeSelect.disabled = true;
                
                try {
                    const response = await fetch('/api/available-times', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ 
                            date: date,
                            duration: parseInt(document.getElementById('manualServiceDuration').value) || 60
                        })
                    });
                    
                    const data = await response.json();
                    console.log('📡 Calendar available times response:', data);
                    
                    if (data.success && data.availableTimes && data.availableTimes.length > 0) {
                        timeSelect.innerHTML = '<option value="">Select available time...</option>';
                        
                        data.availableTimes.forEach(time => {
                            const option = document.createElement('option');
                            option.value = time;
                            option.textContent = time;
                            timeSelect.appendChild(option);
                        });
                        
                        console.log('✅ Loaded', data.availableTimes.length, 'available times for calendar manual booking');
                    } else {
                        timeSelect.innerHTML = '<option value="">No available times for this date</option>';
                        console.log('❌ No available times for date:', date);
                    }
                    
                } catch (error) {
                    console.error('❌ Error loading available times for calendar:', error);
                    timeSelect.innerHTML = '<option value="">Error loading times - check server connection</option>';
                } finally {
                    timeSelect.disabled = false;
                }
            }
            
            function closeManualBookingModal() {
                document.getElementById('manualBookingModal').style.display = 'none';
                document.getElementById('manualBookingForm').reset();
            }
            
            // Update available times when service duration changes
            function updateAvailableTimesForDuration() {
                // Reload available times with new duration if we have a current booking date
                if (window.currentBookingDate) {
                    console.log('🔄 Duration changed, reloading available times with new duration');
                    loadAvailableTimesForManualBooking(window.currentBookingDate);
                }
            }
            
            // Initialize time filtering when page loads
            updateAvailableTimesForDuration();
            
            // Add event listener for duration changes
            document.getElementById('manualServiceDuration').addEventListener('change', updateAvailableTimesForDuration);
            
            // Load available times for personal event (similar to manual booking)
            async function loadAvailableTimesForPersonalEvent(date) {
                const timeSelect = document.getElementById('eventTime');
                const durationSelect = document.getElementById('eventDuration');
                const duration = parseInt(durationSelect.value);
                
                // Handle entire day option
                if (duration >= 720) {
                    timeSelect.innerHTML = '<option value="">Not needed for entire day block</option>';
                    document.getElementById('timeNote').style.display = 'block';
                    document.getElementById('personalEventTimeHelp').style.display = 'none';
                    return;
                } else {
                    document.getElementById('timeNote').style.display = 'none';
                    document.getElementById('personalEventTimeHelp').style.display = 'block';
                }
                
                try {
                    timeSelect.innerHTML = '<option value="">Loading available times...</option>';
                    
                    const response = await fetch('/api/available-times', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ 
                            date: date,
                            duration: duration
                        })
                    });
                    
                    const data = await response.json();
                    
                    if (data.success && data.availableTimes && data.availableTimes.length > 0) {
                        timeSelect.innerHTML = '<option value="">Select a time...</option>' + 
                            data.availableTimes.map(time => '<option value="' + time + '">' + time + '</option>').join('');
                    } else {
                        timeSelect.innerHTML = '<option value="">No available times for this duration</option>';
                    }
                    
                } catch (error) {
                    console.error('Error loading available times for personal event:', error);
                    timeSelect.innerHTML = '<option value="">Error loading times</option>';
                }
            }
            
            document.getElementById('manualBookingForm').addEventListener('submit', async function(e) {
                e.preventDefault();
                
                const formData = {
                    customerName: document.getElementById('manualCustomerName').value,
                    customerPhone: document.getElementById('manualCustomerPhone').value,
                    customerEmail: document.getElementById('manualCustomerEmail').value,
                    service: {
                        name: document.getElementById('manualServiceName').value,
                        price: parseFloat(document.getElementById('manualServicePrice').value),
                        duration: parseInt(document.getElementById('manualServiceDuration').value)
                    },
                    date: window.currentBookingDate,
                    time: document.getElementById('manualBookingTime').value,
                    paymentStatus: document.getElementById('manualPaymentStatus').value,
                    notes: document.getElementById('manualAppointmentNotes').value
                };
                
                try {
                    const response = await fetch('/api/manual-booking', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(formData)
                    });
                    
                    const result = await response.json();
                    if (result.success) {
                        alert('Manual booking added successfully!');
                        closeManualBookingModal();
                        location.reload();
                    } else {
                        alert('Error adding manual booking: ' + result.error);
                    }
                } catch (error) {
                    console.error('Error adding manual booking:', error);
                    alert('Error adding manual booking: ' + error.message);
                }
            });
            
            // Quick appointment modal functions
            function openQuickAppointmentModal() {
                document.getElementById('quickAppointmentModal').style.display = 'flex';
            }
            
            function closeQuickAppointmentModal() {
                document.getElementById('quickAppointmentModal').style.display = 'none';
                document.getElementById('quickAppointmentForm').reset();
            }
            
            document.getElementById('quickAppointmentForm').addEventListener('submit', async function(e) {
                e.preventDefault();
                
                const formData = {
                    customerName: document.getElementById('quickCustomerName').value,
                    customerPhone: document.getElementById('quickCustomerPhone').value,
                    customerEmail: '', // Not collected in quick form
                    service: {
                        name: document.getElementById('quickServiceName').value,
                        price: parseFloat(document.getElementById('quickServicePrice').value),
                        duration: 60 // Default 1 hour
                    },
                    date: window.currentBookingDate,
                    time: document.getElementById('quickBookingTime').value,
                    paymentStatus: 'unpaid', // Default for old appointments
                    notes: 'Quick appointment entry'
                };
                
                try {
                    const response = await fetch('/api/manual-booking', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(formData)
                    });
                    
                    const result = await response.json();
                    if (result.success) {
                        alert('Quick appointment added successfully!');
                        closeQuickAppointmentModal();
                        location.reload();
                    } else {
                        alert('Error adding appointment: ' + result.error);
                    }
                } catch (error) {
                    console.error('Error adding appointment:', error);
                    alert('Error adding appointment: ' + error.message);
                }
            });
            
            // Refund Management Functions
            let currentRefundBookingId = null;
            
            function showRefundModal(bookingId, customerName, depositAmount) {
                currentRefundBookingId = bookingId;
                
                // Populate refund info
                const refundInfo = document.getElementById('refundInfo');
                refundInfo.innerHTML = \`
                    <div style="text-align: center;">
                        <h4 style="margin: 0 0 10px 0; color: #333;">Customer: \${customerName}</h4>
                        <p style="margin: 5px 0; font-size: 1.1em;"><strong>Deposit Paid: $\${depositAmount.toFixed(2)}</strong></p>
                        <div style="display: flex; justify-content: space-around; margin-top: 15px; font-size: 0.9em;">
                            <div style="text-align: center;">
                                <div style="font-weight: bold; color: #4caf50;">Full Refund</div>
                                <div>$\${depositAmount.toFixed(2)}</div>
                            </div>
                            <div style="text-align: center;">
                                <div style="font-weight: bold; color: #ff9800;">50% Refund</div>
                                <div>$\${(depositAmount * 0.5).toFixed(2)}</div>
                            </div>
                            <div style="text-align: center;">
                                <div style="font-weight: bold; color: #f44336;">No Refund</div>
                                <div>$0.00</div>
                            </div>
                        </div>
                    </div>
                \`;
                
                // Show modal
                document.getElementById('refundModal').style.display = 'flex';
                
                // Reset form
                document.getElementById('refundForm').reset();
            }
            
            function closeRefundModal() {
                document.getElementById('refundModal').style.display = 'none';
                currentRefundBookingId = null;
            }
            
            // Handle refund form submission
            document.getElementById('refundForm').addEventListener('submit', async function(e) {
                e.preventDefault();
                
                const refundType = document.getElementById('refundType').value;
                const refundReason = document.getElementById('refundReason').value;
                
                if (!refundType) {
                    alert('Please select a refund type');
                    return;
                }
                
                // Confirmation message
                let confirmMessage = \`Process \${refundType} refund for this booking?\`;
                if (refundType === 'none') {
                    confirmMessage = 'Mark this booking as no refund (customer was late or no-show)?';
                }
                
                if (!confirm(confirmMessage)) return;
                
                try {
                    const response = await fetch('/api/process-refund', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            bookingId: currentRefundBookingId,
                            refundType: refundType,
                            refundReason: refundReason
                        })
                    });
                    
                    const result = await response.json();
                    if (result.success) {
                        alert(\`Refund processed successfully! \${result.message}\`);
                        closeRefundModal();
                        location.reload();
                    } else {
                        alert('Error processing refund: ' + result.error);
                    }
                } catch (error) {
                    alert('Error processing refund: ' + error.message);
                }
            });
            
            async function toggleTimeSlot(time, currentStatus) {
                if (currentStatus === 'booked') return;
                
                const shouldBlock = currentStatus === 'available';
                
                try {
                    const response = await fetch('/api/toggle-time', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            date: '${date}',
                            time: time,
                            block: shouldBlock
                        })
                    });
                    
                    if (response.ok) {
                        location.reload();
                    }
                } catch (error) {
                    console.error('Error toggling time slot:', error);
                }
            }
            
            async function blockEntireDay() {
                if (!confirm('Block the entire day? This will block all time slots.')) return;
                
                try {
                    const allTimes = ${JSON.stringify(allTimes)};
                    for (const time of allTimes) {
                        await fetch('/api/toggle-time', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                date: '${date}',
                                time: time,
                                block: true
                            })
                        });
                    }
                    location.reload();
                } catch (error) {
                    console.error('Error blocking entire day:', error);
                }
            }
            
            async function unblockEntireDay() {
                if (!confirm('Unblock the entire day? This will unblock all time slots (except booked appointments).')) return;
                
                try {
                    const allTimes = ${JSON.stringify(allTimes)};
                    for (const time of allTimes) {
                        await fetch('/api/toggle-time', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                date: '${date}',
                                time: time,
                                block: false
                            })
                        });
                    }
                    location.reload();
                } catch (error) {
                    console.error('Error unblocking entire day:', error);
                }
            }
            
            async function deleteAppointment(bookingId) {
                if (!confirm('Are you sure you want to delete this appointment?')) return;
                
                try {
                    const response = await fetch('/api/delete-appointment', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ bookingId })
                    });
                    
                    const result = await response.json();
                    if (result.success) {
                        alert('Appointment deleted successfully!');
                        location.reload();
                    } else {
                        alert('Error: ' + result.error);
                    }
                } catch (error) {
                    console.error('Error deleting appointment:', error);
                }
            }
        </script>
    </body>
    </html>`;
}

// Helper function to read bookings file
function readBookingsFile() {
    const fs = require('fs');
    if (fs.existsSync('bookings.json')) {
        const data = fs.readFileSync('bookings.json', 'utf8');
        return JSON.parse(data);
    }
    return [];
}

// Helper function to read blocked times file
function readBlockedTimesFile() {
    const fs = require('fs');
    if (fs.existsSync('blocked-times.json')) {
        const data = fs.readFileSync('blocked-times.json', 'utf8');
        return JSON.parse(data);
    }
    return [];
}

// Helper function to read personal events file
function readPersonalEventsFile() {
    const fs = require('fs');
    if (fs.existsSync('personal-events.json')) {
        const data = fs.readFileSync('personal-events.json', 'utf8');
        return JSON.parse(data);
    }
    return [];
}

// Helper function to format date without timezone issues  
function formatDateSafe(dateInput) {
    let date;
    if (typeof dateInput === 'string') {
        // If it's already in YYYY-MM-DD format, use it as-is
        if (/^\d{4}-\d{2}-\d{2}$/.test(dateInput)) {
            return dateInput;
        }
        // Parse string date
        date = new Date(dateInput);
    } else {
        date = dateInput;
    }

    // Format as YYYY-MM-DD using local timezone to avoid offset issues
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// Helper function to read analytics file
function readAnalyticsFile() {
    try {
        if (fs.existsSync('analytics.json')) {
            const data = fs.readFileSync('analytics.json', 'utf8');
            return JSON.parse(data);
        }
        return {
            visitors: { total: 0, new: 0, returning: 0, sessions: [] },
            bookings: { started: 0, completed: 0, conversions: [] },
            dailyStats: {},
            lastReset: null
        };
    } catch (error) {
        console.error('Error reading analytics file:', error);
        return {
            visitors: { total: 0, new: 0, returning: 0, sessions: [] },
            bookings: { started: 0, completed: 0, conversions: [] },
            dailyStats: {},
            lastReset: null
        };
    }
}

// Helper function to write analytics file
function writeAnalyticsFile(analytics) {
    try {
        fs.writeFileSync('analytics.json', JSON.stringify(analytics, null, 2));
        return true;
    } catch (error) {
        console.error('Error writing analytics file:', error);
        return false;
    }
}

// Helper function to get today's date string
function getTodayString() {
    return new Date().toISOString().split('T')[0];
}

// Helper function to parse time slots into hours (24-hour format)
function parseTimeSlot(timeString) {
    const [time, period] = timeString.split(' ');
    const [hours, minutes] = time.split(':').map(Number);

    let hour24 = hours;
    if (period === 'PM' && hours !== 12) {
        hour24 += 12;
    } else if (period === 'AM' && hours === 12) {
        hour24 = 0;
    }

    return hour24 + (minutes || 0) / 60;
}

// API endpoint for today's data
app.get('/api/today-data', (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    const bookings = readBookingsFile();

    // Get today's bookings (only main bookings, not blocked slots)
    const todayBookings = bookings.filter(b =>
        b.date.split('T')[0] === today && b.isMainBooking === true
    );

    // Calculate total revenue from main bookings only
    const totalRevenue = todayBookings.reduce((sum, b) => sum + b.totalAmount, 0);

    // Get next booking TODAY only (in chronological order)
    const now = new Date();

    // Convert today's bookings to include time objects and sort chronologically
    const todayBookingsWithTime = todayBookings.map(b => {
        const [hours, minutes] = b.time.split(':');
        const period = b.time.includes('PM');
        let hour24 = parseInt(hours);
        if (period && hour24 !== 12) hour24 += 12;
        if (!period && hour24 === 12) hour24 = 0;

        const bookingTime = new Date(today);
        bookingTime.setHours(hour24, parseInt(minutes), 0, 0);

        return {
            ...b,
            dateTime: bookingTime
        };
    }).sort((a, b) => a.dateTime - b.dateTime); // Sort by time

    // Find the next appointment today (or first appointment if none are upcoming)
    const nextBooking = todayBookingsWithTime.find(b => b.dateTime > now) ||
        (todayBookingsWithTime.length > 0 ? todayBookingsWithTime[0] : null);

    // Calculate week revenue
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
    const weekStart = oneWeekAgo.toISOString().split('T')[0];

    const weekBookings = bookings.filter(b =>
        b.date.split('T')[0] >= weekStart && b.isMainBooking === true
    );
    const weekRevenue = weekBookings.reduce((sum, b) => sum + b.totalAmount, 0);

    res.json({
        bookings: todayBookings,
        totalRevenue,
        weekRevenue,
        nextBooking
    });
});

// API endpoint for time slots
app.get('/api/time-slots', (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    const bookings = readBookingsFile();
    const blockedTimes = readBlockedTimesFile();

    // Get today's bookings and blocks
    const todayBookings = bookings.filter(b => b.date.split('T')[0] === today);
    const todayBlocked = blockedTimes.filter(bt => bt.date === today);

    // Generate all time slots
    const slots = ['9:00 AM', '10:00 AM', '11:00 AM', '12:00 PM', '1:00 PM', '2:00 PM',
        '3:00 PM', '4:00 PM', '5:00 PM', '6:00 PM', '7:00 PM', '8:00 PM', '9:00 PM'
    ].map(time => ({
        time,
        status: todayBookings.some(b => b.time === time) ? 'booked' :
            todayBlocked.some(b => b.time === time) ? 'blocked' : 'available'
    }));

    res.json({ slots });
});

// API endpoint for analytics data
app.get('/api/analytics-data', (req, res) => {
    const bookings = readBookingsFile();

    // Get only main bookings (not blocked slots)
    const mainBookings = bookings.filter(b => b.isMainBooking === true);

    // Calculate monthly revenue (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const monthStart = thirtyDaysAgo.toISOString().split('T')[0];

    const monthlyBookings = mainBookings.filter(b =>
        b.date.split('T')[0] >= monthStart
    );
    const monthlyRevenue = monthlyBookings.reduce((sum, b) => sum + b.totalAmount, 0);

    // Total unique customers
    const uniqueCustomers = new Set(mainBookings.map(b => b.customerEmail || b.customerPhone)).size;

    // Average booking value
    const avgBooking = mainBookings.length > 0 ?
        mainBookings.reduce((sum, b) => sum + b.totalAmount, 0) / mainBookings.length : 0;

    // Service breakdown with proper categorization
    const serviceCount = {
        'Brow Services': 0,
        'Lash Services': 0,
        'Teeth Whitening': 0,
        'Facial Treatments': 0,
        'Waxing Services': 0,
        'Other Services': 0
    };

    mainBookings.forEach(booking => {
        booking.services.forEach(service => {
            const serviceName = service.name.toLowerCase();

            if (serviceName.includes('brow') || serviceName.includes('lamination')) {
                serviceCount['Brow Services']++;
            } else if (serviceName.includes('lash') || serviceName.includes('extension') || serviceName.includes('lift')) {
                serviceCount['Lash Services']++;
            } else if (serviceName.includes('teeth') || serviceName.includes('whitening')) {
                serviceCount['Teeth Whitening']++;
            } else if (serviceName.includes('facial') || serviceName.includes('ear candling')) {
                serviceCount['Facial Treatments']++;
            } else if (serviceName.includes('wax') || serviceName.includes('brazilian') || serviceName.includes('leg')) {
                serviceCount['Waxing Services']++;
            } else {
                serviceCount['Other Services']++;
            }
        });
    });

    // Find top service
    const topServiceName = Object.keys(serviceCount).reduce((a, b) =>
        serviceCount[a] > serviceCount[b] ? a : b
    );

    // Format service breakdown for frontend
    const serviceBreakdown = [
        { name: 'Brow Services', count: serviceCount['Brow Services'], color: '#ff6b6b' },
        { name: 'Lash Services', count: serviceCount['Lash Services'], color: '#4caf50' },
        { name: 'Teeth Whitening', count: serviceCount['Teeth Whitening'], color: '#2196f3' },
        { name: 'Facial Treatments', count: serviceCount['Facial Treatments'], color: '#ff9800' },
        { name: 'Waxing Services', count: serviceCount['Waxing Services'], color: '#9c27b0' },
        { name: 'Other Services', count: serviceCount['Other Services'], color: '#607d8b' }
    ].filter(service => service.count > 0); // Only show services with bookings

    res.json({
        monthlyRevenue,
        totalCustomers: uniqueCustomers,
        avgBooking,
        topService: serviceCount[topServiceName] > 0 ? topServiceName : 'No Services Yet',
        serviceBreakdown
    });
});

// Analytics API endpoints
app.post('/api/analytics/visitor', (req, res) => {
    try {
        const { sessionId, isReturning, timestamp, userAgent, referrer } = req.body;
        const analytics = readAnalyticsFile();
        const today = getTodayString();

        // Update visitor counts
        analytics.visitors.total++;
        if (isReturning) {
            analytics.visitors.returning++;
        } else {
            analytics.visitors.new++;
        }

        // Add session data
        analytics.visitors.sessions.push({
            sessionId,
            isReturning,
            timestamp,
            userAgent,
            referrer,
            date: today
        });

        // Update daily stats
        if (!analytics.dailyStats[today]) {
            analytics.dailyStats[today] = {
                visitors: 0,
                newVisitors: 0,
                returningVisitors: 0,
                bookingsStarted: 0,
                bookingsCompleted: 0
            };
        }
        analytics.dailyStats[today].visitors++;
        if (isReturning) {
            analytics.dailyStats[today].returningVisitors++;
        } else {
            analytics.dailyStats[today].newVisitors++;
        }

        // Keep only last 90 days of sessions
        const ninetyDaysAgo = new Date();
        ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
        const cutoffTime = ninetyDaysAgo.getTime();

        analytics.visitors.sessions = analytics.visitors.sessions.filter(
            session => session.timestamp > cutoffTime
        );

        writeAnalyticsFile(analytics);
        res.json({ success: true });
    } catch (error) {
        console.error('Error tracking visitor:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/analytics/booking-started', (req, res) => {
    try {
        const { sessionId, timestamp, services } = req.body;
        const analytics = readAnalyticsFile();
        const today = getTodayString();

        // Update booking started count
        analytics.bookings.started++;

        // Add conversion data
        analytics.bookings.conversions.push({
            sessionId,
            timestamp,
            services,
            date: today,
            status: 'started'
        });

        // Update daily stats
        if (!analytics.dailyStats[today]) {
            analytics.dailyStats[today] = {
                visitors: 0,
                newVisitors: 0,
                returningVisitors: 0,
                bookingsStarted: 0,
                bookingsCompleted: 0
            };
        }
        analytics.dailyStats[today].bookingsStarted++;

        writeAnalyticsFile(analytics);
        res.json({ success: true });
    } catch (error) {
        console.error('Error tracking booking started:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/analytics/booking-completed', (req, res) => {
    try {
        const { sessionId, bookingId, amount, timestamp, services, timeToBook } = req.body;
        const analytics = readAnalyticsFile();
        const today = getTodayString();

        // Update booking completed count
        analytics.bookings.completed++;

        // Update the conversion to completed
        const conversionIndex = analytics.bookings.conversions.findIndex(
            c => c.sessionId === sessionId && c.status === 'started'
        );
        if (conversionIndex !== -1) {
            analytics.bookings.conversions[conversionIndex].status = 'completed';
            analytics.bookings.conversions[conversionIndex].bookingId = bookingId;
            analytics.bookings.conversions[conversionIndex].amount = amount;
            analytics.bookings.conversions[conversionIndex].timeToBook = timeToBook;
        } else {
            // If no started conversion found, create a new one
            analytics.bookings.conversions.push({
                sessionId,
                bookingId,
                amount,
                timestamp,
                services,
                date: today,
                status: 'completed',
                timeToBook
            });
        }

        // Update daily stats
        if (!analytics.dailyStats[today]) {
            analytics.dailyStats[today] = {
                visitors: 0,
                newVisitors: 0,
                returningVisitors: 0,
                bookingsStarted: 0,
                bookingsCompleted: 0
            };
        }
        analytics.dailyStats[today].bookingsCompleted++;

        writeAnalyticsFile(analytics);
        res.json({ success: true });
    } catch (error) {
        console.error('Error tracking booking completed:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Analytics dashboard endpoint - ENHANCED PROFESSIONAL VERSION
app.get('/api/analytics/dashboard', (req, res) => {
    try {
        const analytics = readAnalyticsFile();
        const bookings = readBookingsFile();
        const today = getTodayString();

        // Get main bookings only (not blocked slots)
        const mainBookings = bookings.filter(b => b.isMainBooking === true);

        // Calculate conversion rate
        const conversionRate = analytics.visitors.total > 0
            ? ((analytics.bookings.completed / analytics.visitors.total) * 100).toFixed(2)
            : '0.00';

        // RECURRING CUSTOMER ANALYSIS
        const customerEmails = {};
        const customerBookingHistory = {};

        mainBookings.forEach(booking => {
            const email = booking.customerEmail || booking.customerPhone || 'unknown';
            if (!customerEmails[email]) {
                customerEmails[email] = {
                    email: email,
                    bookings: [],
                    totalSpent: 0,
                    services: {}
                };
            }

            customerEmails[email].bookings.push(booking);
            customerEmails[email].totalSpent += booking.totalAmount || 0;

            // Track services per customer
            if (booking.services) {
                booking.services.forEach(service => {
                    const serviceName = service.name;
                    if (!customerEmails[email].services[serviceName]) {
                        customerEmails[email].services[serviceName] = 0;
                    }
                    customerEmails[email].services[serviceName]++;
                });
            }
        });

        // Find recurring customers (2+ bookings)
        const recurringCustomers = Object.values(customerEmails).filter(c => c.bookings.length > 1);
        const newCustomers = Object.values(customerEmails).filter(c => c.bookings.length === 1);

        // Calculate customer loyalty metrics
        const avgBookingsPerCustomer = Object.values(customerEmails).length > 0
            ? (mainBookings.length / Object.values(customerEmails).length).toFixed(1)
            : '0.0';

        const recurringCustomerRate = Object.values(customerEmails).length > 0
            ? ((recurringCustomers.length / Object.values(customerEmails).length) * 100).toFixed(1)
            : '0.0';

        // SERVICE POPULARITY ANALYSIS
        const serviceStats = {};
        const serviceRevenue = {};

        mainBookings.forEach(booking => {
            if (booking.services) {
                booking.services.forEach(service => {
                    const serviceName = service.name;

                    if (!serviceStats[serviceName]) {
                        serviceStats[serviceName] = {
                            name: serviceName,
                            count: 0,
                            revenue: 0,
                            customers: new Set(),
                            recurringCustomers: 0
                        };
                    }

                    serviceStats[serviceName].count++;
                    serviceStats[serviceName].revenue += service.price || 0;
                    serviceStats[serviceName].customers.add(booking.customerEmail || booking.customerPhone);

                    // Check if this customer has booked this service before
                    const customerEmail = booking.customerEmail || booking.customerPhone;
                    if (customerEmails[customerEmail] && customerEmails[customerEmail].services[serviceName] > 1) {
                        serviceStats[serviceName].recurringCustomers++;
                    }
                });
            }
        });

        // Convert sets to counts and sort by popularity
        const popularServices = Object.values(serviceStats)
            .map(service => ({
                ...service,
                uniqueCustomers: service.customers.size,
                avgRevenuePerBooking: service.count > 0 ? (service.revenue / service.count).toFixed(2) : '0.00',
                rebookRate: service.customers.size > 0 ? ((service.recurringCustomers / service.customers.size) * 100).toFixed(1) : '0.0'
            }))
            .sort((a, b) => b.count - a.count);

        // TOP CUSTOMERS ANALYSIS
        const topCustomers = Object.values(customerEmails)
            .sort((a, b) => b.totalSpent - a.totalSpent)
            .slice(0, 10)
            .map(customer => ({
                email: customer.email,
                bookingCount: customer.bookings.length,
                totalSpent: customer.totalSpent,
                avgBookingValue: (customer.totalSpent / customer.bookings.length).toFixed(2),
                favoriteService: Object.keys(customer.services).reduce((a, b) =>
                    customer.services[a] > customer.services[b] ? a : b, Object.keys(customer.services)[0] || 'None'
                ),
                isRecurring: customer.bookings.length > 1
            }));

        // REVENUE ANALYSIS
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        const monthlyBookings = mainBookings.filter(b =>
            new Date(b.date) >= thirtyDaysAgo
        );
        const monthlyRevenue = monthlyBookings.reduce((sum, b) => sum + (b.totalAmount || 0), 0);
        const avgBookingValue = mainBookings.length > 0
            ? (mainBookings.reduce((sum, b) => sum + (b.totalAmount || 0), 0) / mainBookings.length).toFixed(2)
            : '0.00';

        // Get last 30 days stats
        const last30Days = [];
        for (let i = 29; i >= 0; i--) {
            const date = new Date();
            date.setDate(date.getDate() - i);
            const dateStr = date.toISOString().split('T')[0];

            const dayStats = analytics.dailyStats[dateStr] || {
                visitors: 0,
                newVisitors: 0,
                returningVisitors: 0,
                bookingsStarted: 0,
                bookingsCompleted: 0
            };

            // Add revenue for this day
            const dayBookings = mainBookings.filter(b => formatDateSafe(b.date) === dateStr);
            const dayRevenue = dayBookings.reduce((sum, b) => sum + (b.totalAmount || 0), 0);

            last30Days.push({
                date: dateStr,
                ...dayStats,
                revenue: dayRevenue,
                bookings: dayBookings.length
            });
        }

        // Today's stats
        const todayStats = analytics.dailyStats[today] || {
            visitors: 0,
            newVisitors: 0,
            returningVisitors: 0,
            bookingsStarted: 0,
            bookingsCompleted: 0
        };

        const todayBookings = mainBookings.filter(b => formatDateSafe(b.date) === today);
        const todayRevenue = todayBookings.reduce((sum, b) => sum + (b.totalAmount || 0), 0);

        res.json({
            success: true,
            summary: {
                totalVisitors: analytics.visitors.total,
                newVisitors: analytics.visitors.new,
                returningVisitors: analytics.visitors.returning,
                bookingsStarted: analytics.bookings.started,
                bookingsCompleted: analytics.bookings.completed,
                conversionRate: parseFloat(conversionRate),
                totalRevenue: mainBookings.reduce((sum, b) => sum + (b.totalAmount || 0), 0),
                avgBookingValue: parseFloat(avgBookingValue),
                totalCustomers: Object.values(customerEmails).length,
                recurringCustomers: recurringCustomers.length,
                newCustomers: newCustomers.length,
                recurringCustomerRate: parseFloat(recurringCustomerRate),
                avgBookingsPerCustomer: parseFloat(avgBookingsPerCustomer)
            },
            revenue: {
                monthly: monthlyRevenue,
                daily: todayRevenue,
                avgBooking: parseFloat(avgBookingValue)
            },
            customers: {
                total: Object.values(customerEmails).length,
                recurring: recurringCustomers.length,
                new: newCustomers.length,
                topCustomers: topCustomers
            },
            services: {
                popular: popularServices,
                mostPopular: popularServices[0]?.name || 'No services yet',
                bestRebookRate: popularServices.sort((a, b) => parseFloat(b.rebookRate) - parseFloat(a.rebookRate))[0]
            },
            today: {
                ...todayStats,
                revenue: todayRevenue,
                bookings: todayBookings.length
            },
            last30Days: last30Days,
            lastReset: analytics.lastReset
        });
    } catch (error) {
        console.error('Error getting analytics dashboard:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// API to get available times for a specific date with smart time-packing
app.post('/api/available-times', (req, res) => {
    const { date, slotsNeeded = 1, duration = 60 } = req.body;

    console.log('🔍 BACKEND DEBUGGING: Received request:', {
        date: date,
        slotsNeeded: slotsNeeded,
        duration: duration,
        requestBody: req.body
    });

    try {
        // HOURLY INTERVALS to match frontend (simplified for bundles)
        const allTimes = [
            '9:00 AM', '10:00 AM', '11:00 AM', '12:00 PM', '1:00 PM', '2:00 PM',
            '3:00 PM', '4:00 PM', '5:00 PM', '6:00 PM', '7:00 PM', '8:00 PM', '9:00 PM'
        ];

        // Get blocked times, existing bookings, and personal events
        const blockedTimes = readBlockedTimesFile();
        const bookings = readBookingsFile();
        const personalEvents = readPersonalEventsFile();

        console.log(`🔍 BACKEND: Checking availability for ${date}`);

        // Get current date/time for filtering past slots
        const now = new Date();
        const currentDate = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0'); // LOCAL date, not UTC
        const currentTime = now.getHours() * 60 + now.getMinutes(); // Current time in minutes since midnight
        const isToday = date === currentDate;

        console.log(`🕒 Current time: ${now.toLocaleTimeString()}, Checking date: ${date}, Current date: ${currentDate}, Is today: ${isToday}`);

        // Helper function to convert time string to minutes since midnight
        function timeToMinutes(timeStr) {
            const [time, period] = timeStr.split(' ');
            let [hours, minutes] = time.split(':').map(Number);

            if (period === 'PM' && hours !== 12) hours += 12;
            if (period === 'AM' && hours === 12) hours = 0;

            return hours * 60 + minutes;
        }

        // Filter times: Remove blocked times, booked times, AND past times if it's today
        const availableTimes = allTimes.filter(time => {
            // Check if time is blocked by Mary
            const isBlocked = blockedTimes.some(bt => bt.date === date && bt.time === time);
            if (isBlocked) {
                console.log(`❌ ${time} blocked by Mary`);
                return false;
            }

            // Check if time is already booked by a customer
            const isBooked = bookings.some(booking => {
                const bookingDate = formatDateSafe(booking.date);
                return bookingDate === date && booking.time === time;
            });
            if (isBooked) {
                console.log(`❌ ${time} already booked`);
                return false;
            }

            // Check if time is blocked by personal events
            const isPersonalEventBlocked = personalEvents.some(event => {
                const eventDate = formatDateSafe(event.date);
                if (eventDate !== date) return false;

                // Convert times to minutes for overlap checking
                const eventStartMinutes = timeToMinutes(event.time);
                const eventDuration = parseInt(event.duration) || 60;
                const eventEndMinutes = eventStartMinutes + eventDuration;

                const timeSlotMinutes = timeToMinutes(time);
                const timeSlotEndMinutes = timeSlotMinutes + 60; // Each slot is 1 hour

                // Check for overlap: event blocks this time slot if they overlap
                const hasOverlap = (timeSlotMinutes < eventEndMinutes) && (timeSlotEndMinutes > eventStartMinutes);

                if (hasOverlap) {
                    console.log(`❌ ${time} blocked by personal event: ${event.title} (${event.time} for ${event.duration} min)`);
                }

                return hasOverlap;
            });
            if (isPersonalEventBlocked) return false;

            // If it's today, check if the time has already passed + 60 minute buffer
            if (isToday) {
                const timeInMinutes = timeToMinutes(time);
                const bufferMinutes = 60; // 1 hour advance booking required
                if (timeInMinutes <= (currentTime + bufferMinutes)) {
                    console.log(`⏰ ${time} too close - need 1hr buffer (${timeInMinutes} <= ${currentTime + bufferMinutes})`);
                    return false;
                }
            }

            // Check business hour cutoffs based on service duration
            const timeInMinutes = timeToMinutes(time);
            const serviceDurationHours = Math.ceil(duration / 60);

            if (serviceDurationHours >= 3) {
                // 3+ hour services: Must start by 6:00 PM to end by 9:00 PM
                if (timeInMinutes > 18 * 60) { // 18:00 = 6:00 PM
                    console.log(`⏰ ${time} too late for ${serviceDurationHours}-hour service (cutoff: 6:00 PM)`);
                    return false;
                }
            } else {
                // 1-2 hour services: Must start by 7:00 PM to end by 8:00-9:00 PM
                if (timeInMinutes > 19 * 60) { // 19:00 = 7:00 PM
                    console.log(`⏰ ${time} too late for ${serviceDurationHours}-hour service (cutoff: 7:00 PM)`);
                    return false;
                }
            }

            console.log(`✅ ${time} available`);
            return true;
        });

        console.log(`📅 Available times for ${date}: ${availableTimes.length} slots`);

        res.json({
            success: true,
            availableTimes: availableTimes,
            debug: {
                totalBlockedTimes: blockedTimes.filter(bt => bt.date === date).length,
                totalBookings: bookings.filter(b => formatDateSafe(b.date) === date).length
            }
        });

    } catch (error) {
        console.error('Error getting available times:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// API to get availability status for multiple dates (for calendar visual indicators)
app.post('/api/bulk-availability', (req, res) => {
    const { dates, slotsNeeded = 1, duration = 60 } = req.body;

    console.log('🔍 BULK AVAILABILITY: Checking dates:', dates);

    try {
        const allTimes = [
            '9:00 AM', '10:00 AM', '11:00 AM', '12:00 PM', '1:00 PM', '2:00 PM',
            '3:00 PM', '4:00 PM', '5:00 PM', '6:00 PM', '7:00 PM', '8:00 PM', '9:00 PM'
        ];

        // Get blocked times, existing bookings, and personal events
        const blockedTimes = readBlockedTimesFile();
        const bookings = readBookingsFile();
        const personalEvents = readPersonalEventsFile();

        // Get current date/time for filtering past slots
        const now = new Date();
        const currentDate = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
        const currentTime = now.getHours() * 60 + now.getMinutes();

        // Helper function to convert time string to minutes since midnight
        function timeToMinutes(timeStr) {
            const [time, period] = timeStr.split(' ');
            let [hours, minutes] = time.split(':').map(Number);

            if (period === 'PM' && hours !== 12) hours += 12;
            if (period === 'AM' && hours === 12) hours = 0;

            return hours * 60 + minutes;
        }

        const dateAvailability = {};

        dates.forEach(date => {
            const isToday = date === currentDate;

            // Check if this date has entire day blocked (personal events)
            const hasEntireDayBlock = blockedTimes.some(bt =>
                bt.date === date &&
                bt.reason === 'personal-event' &&
                bt.eventDuration >= 720 // 12+ hours = entire day
            );

            if (hasEntireDayBlock) {
                dateAvailability[date] = {
                    hasAvailability: false,
                    availableCount: 0,
                    isEntireDayBlocked: true
                };
                return;
            }

            // Filter times: Remove blocked times, booked times, personal events, AND past times if it's today
            const availableTimes = allTimes.filter(time => {
                // Check if time is blocked by Mary
                const isBlocked = blockedTimes.some(bt => bt.date === date && bt.time === time);
                if (isBlocked) return false;

                // Check if time is already booked by a customer
                const isBooked = bookings.some(booking => {
                    const bookingDate = formatDateSafe(booking.date);
                    return bookingDate === date && booking.time === time;
                });
                if (isBooked) return false;

                // Check if time is blocked by personal events
                const isPersonalEventBlocked = personalEvents.some(event => {
                    const eventDate = formatDateSafe(event.date);
                    if (eventDate !== date) return false;

                    // Check if this time slot falls within the personal event duration
                    const eventStartMinutes = timeToMinutes(event.time);
                    const eventDurationMinutes = event.duration;
                    const eventEndMinutes = eventStartMinutes + eventDurationMinutes;
                    const currentTimeMinutes = timeToMinutes(time);

                    // Block if current time overlaps with personal event
                    return currentTimeMinutes >= eventStartMinutes && currentTimeMinutes < eventEndMinutes;
                });
                if (isPersonalEventBlocked) return false;

                // If it's today, check if the time has already passed + 60 minute buffer
                if (isToday) {
                    const timeInMinutes = timeToMinutes(time);
                    const bufferMinutes = 60; // 1 hour advance booking required
                    if (timeInMinutes <= (currentTime + bufferMinutes)) {
                        return false;
                    }
                }

                // Check business hour cutoffs based on service duration
                const timeInMinutes = timeToMinutes(time);
                const serviceDurationHours = Math.ceil(duration / 60);

                if (serviceDurationHours >= 3) {
                    // 3+ hour services: Must start by 6:00 PM to end by 9:00 PM
                    if (timeInMinutes > 18 * 60) { // 18:00 = 6:00 PM
                        return false;
                    }
                } else {
                    // 1-2 hour services: Must start by 7:00 PM to end by 8:00-9:00 PM
                    if (timeInMinutes > 19 * 60) { // 19:00 = 7:00 PM
                        return false;
                    }
                }

                return true;
            });

            dateAvailability[date] = {
                hasAvailability: availableTimes.length > 0,
                availableCount: availableTimes.length,
                isEntireDayBlocked: false
            };
        });

        res.json({
            success: true,
            dateAvailability: dateAvailability
        });

    } catch (error) {
        console.error('Error getting bulk availability:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Customer Cards API - Get saved payment methods
app.post('/api/customer-cards', async (req, res) => {
    const { email } = req.body;

    try {
        console.log('🔍 CHECKING SAVED CARDS FOR:', email);

        // Get customer by email
        const { result: searchResult } = await squareClient.customersApi.searchCustomers({
            filter: {
                emailAddress: {
                    exact: email
                }
            }
        });

        if (!searchResult.customers || searchResult.customers.length === 0) {
            return res.json({ cards: [] });
        }

        const customer = searchResult.customers[0];
        console.log('📋 FOUND CUSTOMER:', customer.id);

        // Get customer's saved cards
        const { result: cardsResult } = await squareClient.cardsApi.listCards(
            undefined, // cursor
            customer.id
        );

        if (!cardsResult.cards || cardsResult.cards.length === 0) {
            return res.json({ cards: [] });
        }

        // Format cards for frontend
        const formattedCards = cardsResult.cards.map(card => ({
            id: card.id,
            lastFour: card.last4,
            cardBrand: card.cardBrand,
            expMonth: card.expMonth,
            expYear: card.expYear,
            enabled: card.enabled
        })).filter(card => card.enabled);

        console.log('💳 FOUND SAVED CARDS:', formattedCards.length);
        res.json({ cards: formattedCards });

    } catch (error) {
        console.error('❌ Error fetching customer cards:', error);
        res.json({ cards: [] }); // Return empty array instead of error
    }
});

// Calculate how many minutes are used in each time slot for a given date
function calculateSlotUsage(bookings, date) {
    const slotUsage = {};

    bookings.forEach(booking => {
        // Check if booking is for the requested date
        if (booking.date.split('T')[0] === date) {
            const bookingTime = booking.time;
            const services = booking.services || [];

            // Calculate total actual service duration
            let totalServiceDuration = 0;
            services.forEach(service => {
                if (service.durationMinutes) {
                    totalServiceDuration += service.durationMinutes;
                } else if (service.duration) {
                    // Parse duration string (e.g., "30 min", "1 hour")
                    totalServiceDuration += parseDurationToMinutes(service.duration);
                } else {
                    totalServiceDuration += 60; // Default 1 hour
                }
            });

            // IMPORTANT: For slot usage calculation, we track exactly which slots are occupied
            // This is different from slot duration - it's about marking specific time slots as busy

            // HOUR-ONLY INTERVALS: All services must be 1, 2, or 3 hours
            if (totalServiceDuration <= 60) {
                // 1-hour services occupy their specific hour slot
                if (!slotUsage[bookingTime]) {
                    slotUsage[bookingTime] = 0;
                }
                slotUsage[bookingTime] = 60; // Mark this hour slot as used
            } else {
                // Multi-hour services: block all the hour slots they need
                const slotsToBlock = calculateHourSlotsToBlock(bookingTime, totalServiceDuration);
                slotsToBlock.forEach(slot => {
                    slotUsage[slot] = 60; // Mark full hour as occupied
                });
            }
        }
    });

    return slotUsage;
}

// REMOVED: No more 30-minute slots - HOUR INTERVALS ONLY

// Helper function to calculate all HOUR slots that should be blocked for multi-hour services
function calculateHourSlotsToBlock(startTime, durationMinutes) {
    const slotsToBlock = [startTime];

    // For services longer than 60 minutes, block additional hour slots
    if (durationMinutes > 60) {
        const hoursNeeded = Math.ceil(durationMinutes / 60);

        for (let i = 1; i < hoursNeeded; i++) {
            const nextSlot = getNextHourSlot(startTime, i);
            if (nextSlot) {
                slotsToBlock.push(nextSlot);
                // NO 30-minute slots - only block hour slots
            }
        }
    }

    return slotsToBlock;
}

// Helper function to parse duration strings to minutes
function parseDurationToMinutes(durationStr) {
    if (!durationStr) return 60;

    const match = durationStr.match(/(\d+)\s*(min|minute|hour|hr)/i);
    if (!match) return 60;

    const value = parseInt(match[1]);
    const unit = match[2].toLowerCase();

    if (unit.startsWith('min')) {
        return value;
    } else if (unit.startsWith('hour') || unit === 'hr') {
        return value * 60;
    }

    return 60;
}

// Helper function to get the next hour slot
function getNextHourSlot(timeStr, hoursToAdd) {
    const [time, period] = timeStr.split(' ');
    let [hours, minutes] = time.split(':').map(Number);

    // Convert to 24-hour format
    if (period === 'PM' && hours !== 12) hours += 12;
    if (period === 'AM' && hours === 12) hours = 0;

    // Add hours
    hours += hoursToAdd;

    // Handle overflow (past 9 PM)
    if (hours > 21) return null; // 9 PM is the last slot

    // Convert back to 12-hour format
    const period12 = hours >= 12 ? 'PM' : 'AM';
    const hours12 = hours > 12 ? hours - 12 : (hours === 0 ? 12 : hours);

    return `${hours12}:${minutes.toString().padStart(2, '0')} ${period12}`;
}

// API to toggle time availability
app.post('/api/toggle-time', (req, res) => {
    const fs = require('fs');
    const { date, time, block } = req.body;

    try {
        let blockedTimes = readBlockedTimesFile();

        const timeSlot = { date, time, blockedAt: new Date().toISOString() };

        if (block) {
            // Add to blocked times if not already blocked
            if (!blockedTimes.some(bt => bt.date === date && bt.time === time)) {
                blockedTimes.push(timeSlot);
            }
        } else {
            // Remove from blocked times
            blockedTimes = blockedTimes.filter(bt => !(bt.date === date && bt.time === time));
        }

        fs.writeFileSync('blocked-times.json', JSON.stringify(blockedTimes, null, 2));

        console.log(`✅ TIME ${block ? 'BLOCKED' : 'UNBLOCKED'}: ${date} at ${time}`);
        res.json({ success: true, message: `Time ${block ? 'blocked' : 'unblocked'} successfully` });

    } catch (error) {
        console.error('Error toggling time:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// API endpoint to block rest of day
app.post('/api/block-rest-of-day', (req, res) => {
    const fs = require('fs');
    const { date } = req.body;
    const targetDate = date || new Date().toISOString().split('T')[0];
    const now = new Date();
    let blockedTimes = readBlockedTimesFile();
    const bookings = readBookingsFile();

    // Get all times after now (if today) or all times (if future date)
    const times = ['9:00 AM', '10:00 AM', '11:00 AM', '12:00 PM', '1:00 PM', '2:00 PM',
        '3:00 PM', '4:00 PM', '5:00 PM', '6:00 PM', '7:00 PM', '8:00 PM', '9:00 PM'];

    const isToday = targetDate === new Date().toISOString().split('T')[0];

    // Block all available times
    times.forEach(time => {
        if (isToday) {
            // For today, only block future times
            const [hours, minutes] = time.split(':');
            const period = time.includes('PM');
            let hour24 = parseInt(hours);
            if (period && hour24 !== 12) hour24 += 12;
            if (!period && hour24 === 12) hour24 = 0;

            const timeDate = new Date(targetDate);
            timeDate.setHours(hour24, parseInt(minutes), 0, 0);

            // Only block future times that aren't already booked
            if (timeDate > now && !bookings.some(b => b.date.split('T')[0] === targetDate && b.time === time)) {
                // Add to blocked times if not already blocked
                if (!blockedTimes.some(bt => bt.date === targetDate && bt.time === time)) {
                    blockedTimes.push({
                        date: targetDate,
                        time: time,
                        blockedAt: new Date().toISOString()
                    });
                }
            }
        } else {
            // For future dates, block all available times
            if (!bookings.some(b => b.date.split('T')[0] === targetDate && b.time === time)) {
                // Add to blocked times if not already blocked
                if (!blockedTimes.some(bt => bt.date === targetDate && bt.time === time)) {
                    blockedTimes.push({
                        date: targetDate,
                        time: time,
                        blockedAt: new Date().toISOString()
                    });
                }
            }
        }
    });

    // Save blocked times
    fs.writeFileSync('blocked-times.json', JSON.stringify(blockedTimes, null, 2));

    res.json({ success: true });
});



// API endpoint for Mary to book customers in person (WITH SERVICE DURATION BLOCKING)
app.post('/api/book-for-customer', (req, res) => {
    const fs = require('fs');
    const { customerName, customerPhone, customerEmail, service, date, time, notes, paymentMethod } = req.body;

    try {
        // Check if time slot is available and no overlaps
        const dateStr = formatDateSafe(date);
        const serviceDuration = service.duration || 60; // Default 60 minutes

        // Smart booking slot logic - round to sensible time slots
        let totalTimeNeeded;
        if (serviceDuration <= 60) {
            totalTimeNeeded = 60; // Under 1 hour → book 1 hour
        } else if (serviceDuration <= 120) {
            totalTimeNeeded = 120; // 1-2 hours → book 2 hours
        } else if (serviceDuration <= 180) {
            totalTimeNeeded = 180; // 2-3 hours → book 3 hours
        } else {
            totalTimeNeeded = Math.ceil(serviceDuration / 60) * 60; // Anything else, round up to nearest hour
        }

        console.log(`⏰ ONLINE BOOKING SLOTS: ${serviceDuration}min → ${totalTimeNeeded}min booked`);

        console.log('📊 SERVICE BOOKING CALCULATION:', {
            serviceName: service.name,
            serviceDuration,
            totalTimeNeeded,
            requiredSlots: Math.ceil(totalTimeNeeded / 60)
        });

        // Get all time slots for the day
        const allTimeSlots = [
            '9:00 AM', '10:00 AM', '11:00 AM', '12:00 PM', '1:00 PM', '2:00 PM',
            '3:00 PM', '4:00 PM', '5:00 PM', '6:00 PM', '7:00 PM', '8:00 PM', '9:00 PM'
        ];

        // Calculate required time slots based on duration
        const startIndex = allTimeSlots.indexOf(time);
        if (startIndex === -1) {
            return res.status(400).json({
                success: false,
                error: 'Invalid time slot'
            });
        }

        // Calculate how many 60-minute slots we need (including buffer)
        const slotsNeeded = Math.ceil(totalTimeNeeded / 60);
        const requiredSlots = allTimeSlots.slice(startIndex, startIndex + slotsNeeded);

        // Read existing bookings
        let bookings = readBookingsFile();

        // Read blocked times FIRST
        const blockedTimes = readBlockedTimesFile();

        console.log('🔍 BOOKING VALIDATION DEBUG:', {
            dateStr,
            requiredSlots,
            blockedTimesCount: blockedTimes.filter(bt => bt.date === dateStr).length,
            allBlockedTimes: blockedTimes.filter(bt => bt.date === dateStr)
        });

        // Check if all required slots are available
        for (const slot of requiredSlots) {
            // Check if booked
            const isBooked = bookings.some(b =>
                b.date.split('T')[0] === dateStr && b.time === slot
            );

            if (isBooked) {
                console.log(`❌ SLOT ${slot} ALREADY BOOKED`);
                return res.status(400).json({
                    success: false,
                    error: `Time slot ${slot} is already booked. This service needs ${serviceDuration} minutes + ${bufferTime} min buffer.`
                });
            }

            // Check if blocked (including personal events)
            const isBlocked = blockedTimes.some(bt =>
                bt.date === dateStr && bt.time === slot
            );

            if (isBlocked) {
                const blockReason = blockedTimes.find(bt => bt.date === dateStr && bt.time === slot);
                console.log(`❌ SLOT ${slot} IS BLOCKED:`, blockReason);
                return res.status(400).json({
                    success: false,
                    error: `Time slot ${slot} is blocked${blockReason?.reason === 'personal-event' ? ' (Personal Event: ' + blockReason.eventTitle + ')' : ''}. This service needs ${serviceDuration} minutes + ${bufferTime} min buffer.`
                });
            }

            console.log(`✅ SLOT ${slot} IS AVAILABLE`);
        }

        // Create one main booking entry and block the required time slots
        const mainBookingData = {
            id: `in-person-booking-${Date.now()}`,
            paymentId: `in-person-${paymentMethod}-${Date.now()}`,
            customerId: `in-person-${Date.now()}`,
            customerName: customerName,
            customerPhone: customerPhone,
            customerEmail: customerEmail || 'in-person@booking.local',
            services: [{
                name: service.name,
                price: service.price,
                duration: service.duration
            }],
            totalDurationMinutes: serviceDuration, // For admin display
            date: formatDateSafe(date),
            time: time,
            totalAmount: service.price,
            notes: notes || '',
            status: 'CONFIRMED',
            paymentMethod: paymentMethod,
            bookedBy: 'admin',
            createdAt: new Date().toISOString(),
            isMainBooking: true,
            serviceDuration: serviceDuration,
            blockedSlots: requiredSlots // Track which slots this booking blocks
        };

        // Add the main booking
        bookings.push(mainBookingData);

        // Add "blocked" entries for additional time slots (not full bookings)
        requiredSlots.slice(1).forEach((slot, index) => {
            const blockedSlotData = {
                id: `${mainBookingData.id}-blocked-${index + 1}`,
                mainBookingId: mainBookingData.id,
                customerName: `[BLOCKED] ${customerName}`,
                customerPhone: customerPhone,
                customerEmail: customerEmail || 'blocked@slot.local',
                services: [{ name: `[BLOCKED FOR] ${service.name}`, price: 0 }],
                date: formatDateSafe(date),
                time: slot,
                totalAmount: 0,
                notes: `Blocked slot for ${service.name}`,
                status: 'BLOCKED',
                paymentMethod: 'blocked',
                bookedBy: 'system',
                createdAt: new Date().toISOString(),
                isMainBooking: false,
                isBlockedSlot: true,
                parentBookingId: mainBookingData.id
            };

            bookings.push(blockedSlotData);
        });

        fs.writeFileSync('bookings.json', JSON.stringify(bookings, null, 2));

        console.log('✅ IN-PERSON BOOKING CREATED:', {
            customer: customerName,
            service: service.name,
            date: dateStr,
            time: time,
            payment: paymentMethod,
            slotsBlocked: requiredSlots.length
        });

        // Send email notification to Mary for in-person booking
        try {
            const https = require('https');
            const querystring = require('querystring');

            const emailData = querystring.stringify({
                '_subject': '👥 IN-PERSON BOOKING CREATED',
                'customer_name': customerName,
                'customer_phone': customerPhone,
                'customer_email': customerEmail || 'Not provided',
                'service': service.name,
                'appointment_date': new Date(date).toLocaleDateString(),
                'appointment_time': time,
                'total_amount': `$${service.price}`,
                'payment_method': paymentMethod.toUpperCase(),
                'notes': notes || 'None',
                'booking_type': 'In-Person Booking',
                '_template': 'box'
            });

            const options = {
                hostname: 'formspree.io',
                port: 443,
                path: '/f/xpwlqjnv',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': Buffer.byteLength(emailData),
                    'Accept': 'application/json'
                }
            };

            const emailReq = https.request(options, (emailRes) => {
                console.log('📧 In-person booking email sent to Mary');
            });

            emailReq.on('error', (error) => {
                console.error('Email notification failed:', error);
            });

            emailReq.write(emailData);
            emailReq.end();

        } catch (emailError) {
            console.error('Email notification error:', emailError);
        }

        res.json({
            success: true,
            booking: mainBookingData,
            message: 'Appointment booked successfully!'
        });

    } catch (error) {
        console.error('Error creating in-person booking:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to create booking'
        });
    }
});

// API endpoint for manual bookings (no payment processing)
app.post('/api/manual-booking', (req, res) => {
    const fs = require('fs');
    const { customerName, customerPhone, customerEmail, service, date, time, paymentStatus, notes, bookingSource } = req.body;

    try {
        // Check if time slot is available
        const dateStr = formatDateSafe(date);
        const serviceDuration = service.duration || 60;

        // Get all time slots for the day
        const allTimeSlots = [
            '9:00 AM', '10:00 AM', '11:00 AM', '12:00 PM', '1:00 PM', '2:00 PM',
            '3:00 PM', '4:00 PM', '5:00 PM', '6:00 PM', '7:00 PM', '8:00 PM', '9:00 PM'
        ];

        // Calculate required time slots based on duration + buffer time
        const startIndex = allTimeSlots.indexOf(time);
        if (startIndex === -1) {
            return res.status(400).json({
                success: false,
                error: 'Invalid time slot'
            });
        }

        // Smart booking slot logic - round to sensible time slots (same as online)
        let totalTimeNeeded;
        if (serviceDuration <= 60) {
            totalTimeNeeded = 60; // Under 1 hour → book 1 hour
        } else if (serviceDuration <= 120) {
            totalTimeNeeded = 120; // 1-2 hours → book 2 hours
        } else if (serviceDuration <= 180) {
            totalTimeNeeded = 180; // 2-3 hours → book 3 hours
        } else {
            totalTimeNeeded = Math.ceil(serviceDuration / 60) * 60; // Anything else, round up to nearest hour
        }

        console.log(`⏰ MANUAL BOOKING SLOTS: ${serviceDuration}min → ${totalTimeNeeded}min booked`);
        const slotsNeeded = Math.ceil(totalTimeNeeded / 60);
        const requiredSlots = allTimeSlots.slice(startIndex, startIndex + slotsNeeded);

        // Read existing bookings
        let bookings = readBookingsFile();
        const blockedTimes = readBlockedTimesFile();

        // Check if any required slots are already booked or blocked
        for (const slot of requiredSlots) {
            const isBooked = bookings.some(b =>
                b.date.split('T')[0] === dateStr && b.time === slot
            );
            const isBlocked = blockedTimes.some(bt =>
                bt.date === dateStr && bt.time === slot
            );

            if (isBooked || isBlocked) {
                return res.status(400).json({
                    success: false,
                    error: `Time slot ${slot} is not available`
                });
            }
        }

        // Calculate payment details based on payment status
        let depositPaid = 0;
        let remainingBalance = service.price;
        let status = 'CONFIRMED';

        switch (paymentStatus) {
            case 'paid-full':
                depositPaid = service.price;
                remainingBalance = 0;
                status = 'CONFIRMED';
                break;
            case 'paid-deposit':
                depositPaid = service.price * 0.5;
                remainingBalance = service.price * 0.5;
                status = 'CONFIRMED';
                break;
            case 'unpaid':
                depositPaid = 0;
                remainingBalance = service.price;
                status = 'CONFIRMED';
                break;
            case 'comp':
                depositPaid = service.price;
                remainingBalance = 0;
                status = 'CONFIRMED';
                break;
        }

        // Create main booking entry
        const mainBookingData = {
            id: `manual-booking-${Date.now()}`,
            paymentId: `manual-${paymentStatus}-${Date.now()}`,
            customerId: `manual-${Date.now()}`,
            customerName: customerName,
            customerPhone: customerPhone,
            customerEmail: customerEmail || 'manual@booking.local',
            services: [{
                name: service.name,
                price: service.price,
                duration: service.duration
            }],
            totalDurationMinutes: serviceDuration, // For admin display
            date: formatDateSafe(date),
            time: time,
            totalAmount: service.price,
            depositPaid: depositPaid,
            remainingBalance: remainingBalance,
            notes: notes || '',
            status: status,
            paymentMethod: paymentStatus === 'comp' ? 'complimentary' : 'manual',
            paymentStatus: paymentStatus,
            bookedBy: 'admin-manual',
            createdAt: new Date().toISOString(),
            isMainBooking: true,
            isManualBooking: true,
            bookingSource: bookingSource || 'manual', // Tag for identifying manual vs online bookings
            serviceDuration: serviceDuration,
            blockedSlots: requiredSlots,
            refundStatus: 'none'
        };

        // Add the main booking
        bookings.push(mainBookingData);

        // Add blocked entries for additional time slots if needed
        requiredSlots.slice(1).forEach((slot, index) => {
            const blockedSlotData = {
                id: `${mainBookingData.id}-blocked-${index + 1}`,
                mainBookingId: mainBookingData.id,
                customerName: `[BLOCKED] ${customerName}`,
                customerPhone: customerPhone,
                customerEmail: customerEmail || 'manual@booking.local',
                services: [{ name: `[BLOCKED FOR] ${service.name}`, price: 0 }],
                date: formatDateSafe(date),
                time: slot,
                totalAmount: 0,
                notes: `Blocked slot for ${service.name}`,
                status: 'BLOCKED',
                paymentMethod: 'blocked',
                bookedBy: 'system',
                createdAt: new Date().toISOString(),
                isMainBooking: false,
                isBlockedSlot: true,
                isManualBooking: true,
                parentBookingId: mainBookingData.id
            };

            bookings.push(blockedSlotData);
        });

        fs.writeFileSync('bookings.json', JSON.stringify(bookings, null, 2));

        console.log('✅ MANUAL BOOKING CREATED:', {
            customer: customerName,
            service: service.name,
            date: dateStr,
            time: time,
            paymentStatus: paymentStatus,
            slotsBlocked: requiredSlots.length
        });

        res.json({
            success: true,
            booking: mainBookingData,
            message: 'Manual booking added successfully!'
        });

    } catch (error) {
        console.error('Error creating manual booking:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to create manual booking'
        });
    }
});

// API endpoint to delete appointments
app.post('/api/delete-appointment', (req, res) => {
    const fs = require('fs');
    const { bookingId } = req.body;

    try {
        // Read existing bookings
        let bookings = readBookingsFile();

        // Find the booking(s) to delete
        const toDelete = bookings.filter(b =>
            b.id === bookingId || b.parentBookingId === bookingId
        );

        if (toDelete.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Booking not found'
            });
        }

        // Get booking details for logging
        const mainBooking = toDelete.find(b => b.isMainBooking === true) || toDelete[0];
        const slotsFreed = toDelete.length;

        // Remove all related bookings and blocked slots
        bookings = bookings.filter(b =>
            b.id !== bookingId && b.parentBookingId !== bookingId
        );

        // Save updated bookings
        fs.writeFileSync('bookings.json', JSON.stringify(bookings, null, 2));

        console.log('🗑️ APPOINTMENT DELETED:', {
            customer: mainBooking.customerName,
            service: mainBooking.services.map(s => s.name).join(', '),
            date: new Date(mainBooking.date).toLocaleDateString(),
            time: mainBooking.time,
            amount: mainBooking.totalAmount,
            slotsFreed: slotsFreed
        });

        // Send cancellation email notification to Mary
        try {
            const https = require('https');
            const querystring = require('querystring');

            const emailData = querystring.stringify({
                '_subject': '❌ APPOINTMENT CANCELLED',
                'customer_name': mainBooking.customerName,
                'customer_phone': mainBooking.customerPhone,
                'customer_email': mainBooking.customerEmail,
                'service': mainBooking.services.map(s => s.name).join(', '),
                'appointment_date': new Date(mainBooking.date).toLocaleDateString(),
                'appointment_time': mainBooking.time,
                'total_amount': `$${mainBooking.totalAmount}`,
                'payment_method': mainBooking.paymentMethod || 'Square',
                'slots_freed': slotsFreed,
                'cancelled_by': 'Admin Panel',
                '_template': 'box'
            });

            const options = {
                hostname: 'formspree.io',
                port: 443,
                path: '/f/xpwlqjnv',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': Buffer.byteLength(emailData),
                    'Accept': 'application/json'
                }
            };

            const emailReq = https.request(options, (emailRes) => {
                console.log('📧 Cancellation email sent to Mary');
            });

            emailReq.on('error', (error) => {
                console.error('Cancellation email failed:', error);
            });

            emailReq.write(emailData);
            emailReq.end();

        } catch (emailError) {
            console.error('Cancellation email error:', emailError);
        }

        res.json({
            success: true,
            message: 'Appointment deleted successfully',
            slotsFreed: slotsFreed,
            customerName: mainBooking.customerName,
            amount: mainBooking.totalAmount
        });

    } catch (error) {
        console.error('Error deleting appointment:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to delete appointment'
        });
    }
});

// API endpoint for personal events
app.post('/api/add-personal-event', (req, res) => {
    const fs = require('fs');
    const { date, time, title, description, color, duration } = req.body;

    try {
        let personalEvents = readPersonalEventsFile();
        let blockedTimes = readBlockedTimesFile();

        const eventDuration = duration || 60; // Default 1 hour

        const newEvent = {
            id: `event-${Date.now()}`,
            date,
            time,
            title,
            description: description || '',
            color: color || '#9c27b0',
            duration: eventDuration,
            createdAt: new Date().toISOString()
        };

        // Add to personal events
        personalEvents.push(newEvent);
        fs.writeFileSync('personal-events.json', JSON.stringify(personalEvents, null, 2));

        // Calculate required time slots based on duration
        const allTimeSlots = [
            '9:00 AM', '10:00 AM', '11:00 AM', '12:00 PM', '1:00 PM', '2:00 PM',
            '3:00 PM', '4:00 PM', '5:00 PM', '6:00 PM', '7:00 PM', '8:00 PM', '9:00 PM'
        ];

        let requiredSlots;

        // Handle "Block Entire Day" (720 minutes = 12 hours)
        if (eventDuration >= 720) {
            requiredSlots = allTimeSlots; // Block all time slots
            console.log('🚫 BLOCKING ENTIRE DAY for personal event:', title);
        } else {
            // Handle hourly blocks
            const startIndex = allTimeSlots.indexOf(time);
            if (startIndex === -1) {
                return res.status(400).json({ success: false, error: 'Invalid time slot' });
            }

            // Calculate how many 60-minute slots we need
            const slotsNeeded = Math.ceil(eventDuration / 60);
            requiredSlots = allTimeSlots.slice(startIndex, startIndex + slotsNeeded);
        }

        // CHECK FOR CONFLICTS FIRST - Don't allow personal events on booked slots
        const bookings = readBookingsFile();
        const conflictingBookings = [];

        requiredSlots.forEach(slotTime => {
            // Check for exact time matches (existing logic)
            const exactMatch = bookings.find(b =>
                b.date.split('T')[0] === date &&
                b.time === slotTime &&
                b.isMainBooking === true
            );
            if (exactMatch) {
                conflictingBookings.push({ time: slotTime, customer: exactMatch.customerName });
                return;
            }

            // Check for multi-hour bookings that span into this slot
            const conflictingSpanBooking = bookings.find(b => {
                if (b.date.split('T')[0] !== date || !b.isMainBooking) return false;

                // Get the booking's duration and calculate which slots it occupies
                const bookingDuration = b.totalDurationMinutes || 60;
                const bookingStartIndex = allTimeSlots.findIndex(slot => slot === b.time);
                if (bookingStartIndex === -1) return false;

                const bookingSlotsNeeded = Math.ceil(bookingDuration / 60);
                const bookingEndIndex = bookingStartIndex + bookingSlotsNeeded;
                const currentSlotIndex = allTimeSlots.findIndex(slot => slot === slotTime);

                // Check if this slot falls within the booking's time span
                return currentSlotIndex >= bookingStartIndex && currentSlotIndex < bookingEndIndex;
            });

            if (conflictingSpanBooking) {
                conflictingBookings.push({
                    time: slotTime,
                    customer: conflictingSpanBooking.customerName,
                    originalStart: conflictingSpanBooking.time,
                    duration: conflictingSpanBooking.totalDurationMinutes || 60
                });
            }
        });

        if (conflictingBookings.length > 0) {
            const errorMessages = conflictingBookings.map(c => {
                if (c.originalStart && c.originalStart !== c.time) {
                    const hours = Math.ceil(c.duration / 60);
                    return `${c.time} (occupied by ${c.customer}'s ${hours}-hour service starting at ${c.originalStart})`;
                } else {
                    return `${c.time} (${c.customer})`;
                }
            });

            return res.status(400).json({
                success: false,
                error: `Cannot add personal event. The following times are already booked: ${errorMessages.join(', ')}`
            });
        }

        // Block all required time slots (now that we've confirmed no conflicts)
        let blockedCount = 0;
        requiredSlots.forEach(slotTime => {
            const blockEntry = {
                date,
                time: slotTime,
                blockedAt: new Date().toISOString(),
                reason: 'personal-event',
                eventId: newEvent.id,
                eventTitle: title
            };

            // Add to blocked times if not already blocked
            if (!blockedTimes.some(bt => bt.date === date && bt.time === slotTime)) {
                blockedTimes.push(blockEntry);
                blockedCount++;
            }
        });

        fs.writeFileSync('blocked-times.json', JSON.stringify(blockedTimes, null, 2));

        const eventType = eventDuration >= 720 ? 'ENTIRE DAY BLOCKED' : 'HOURLY EVENT';
        console.log(`✅ PERSONAL EVENT ADDED - ${eventType}:`, {
            date,
            time: eventDuration >= 720 ? 'All Day' : time,
            title,
            duration: eventDuration >= 720 ? 'Full Day (12 hours)' : `${eventDuration} minutes`,
            slotsBlocked: blockedCount,
            totalSlotsForDay: allTimeSlots.length,
            requiredSlots: eventDuration >= 720 ? 'ALL SLOTS' : requiredSlots
        });

        res.json({ success: true, event: newEvent, slotsBlocked: blockedCount });

    } catch (error) {
        console.error('Error adding personal event:', error);
        res.status(500).json({ success: false, error: 'Failed to add personal event' });
    }
});

app.post('/api/delete-personal-event', (req, res) => {
    const fs = require('fs');
    const { eventId } = req.body;

    try {
        let personalEvents = readPersonalEventsFile();
        let blockedTimes = readBlockedTimesFile();

        const eventToDelete = personalEvents.find(e => e.id === eventId);

        // Remove from personal events
        personalEvents = personalEvents.filter(e => e.id !== eventId);
        fs.writeFileSync('personal-events.json', JSON.stringify(personalEvents, null, 2));

        // ALSO unblock the time slot that was blocked by this event
        if (eventToDelete) {
            blockedTimes = blockedTimes.filter(bt => bt.eventId !== eventId);
            fs.writeFileSync('blocked-times.json', JSON.stringify(blockedTimes, null, 2));
        }

        console.log('🗑️ PERSONAL EVENT DELETED & TIME UNBLOCKED:', {
            title: eventToDelete?.title,
            date: eventToDelete?.date,
            time: eventToDelete?.time,
            unblocked: true
        });

        res.json({ success: true, message: 'Personal event deleted and time unblocked successfully' });

    } catch (error) {
        console.error('Error deleting personal event:', error);
        res.status(500).json({ success: false, error: 'Failed to delete personal event' });
    }
});

app.get('/api/personal-events', (req, res) => {
    try {
        const { date } = req.query;
        const personalEvents = readPersonalEventsFile();

        if (date) {
            // Filter events for specific date
            const dayEvents = personalEvents.filter(e => e.date === date);
            res.json({ success: true, events: dayEvents });
        } else {
            // Return all events
            res.json({ success: true, events: personalEvents });
        }

    } catch (error) {
        console.error('Error getting personal events:', error);
        res.status(500).json({ success: false, error: 'Failed to get personal events' });
    }
});

// DEBUG API endpoint to check blocked times
app.get('/api/debug-blocked-times', (req, res) => {
    try {
        const blockedTimes = readBlockedTimesFile();
        const personalEvents = readPersonalEventsFile();
        const bookings = readBookingsFile();

        console.log('🐛 DEBUG - Current State:');
        console.log('📋 Blocked Times:', blockedTimes.length, 'entries');
        console.log('🎯 Personal Events:', personalEvents.length, 'entries');
        console.log('📅 Bookings:', bookings.length, 'entries');

        res.json({
            success: true,
            debug: {
                blockedTimes,
                personalEvents,
                bookings: bookings.filter(b => b.isMainBooking === true), // Only main bookings
                totalBlockedTimes: blockedTimes.length,
                totalPersonalEvents: personalEvents.length,
                totalBookings: bookings.filter(b => b.isMainBooking === true).length
            }
        });
    } catch (error) {
        console.error('Debug error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// API endpoint to get admin settings
app.get('/api/get-admin-settings', (req, res) => {
    try {
        const settings = readAdminSettings();
        res.json({ success: true, settings });
    } catch (error) {
        console.error('Error reading admin settings:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// API endpoint to save admin settings
app.post('/api/save-admin-settings', (req, res) => {
    const fs = require('fs');

    try {
        const settings = req.body;

        // Save settings to file
        fs.writeFileSync('admin-settings.json', JSON.stringify(settings, null, 2));

        console.log('⚙️ ADMIN SETTINGS SAVED:', {
            bufferTimes: {
                signature: settings.signatureBuffer,
                facial: settings.facialBuffer,
                brow: settings.browBuffer,
                lash: settings.lashBuffer,
                waxing: settings.waxingBuffer,
                specialty: settings.specialtyBuffer
            },
            autoBlockSundays: settings.autoBlockSundays,
            requireDeposit: settings.requireDeposit,
            emailNotifications: settings.emailNotifications,
            businessHours: `${settings.openTime} - ${settings.closeTime}`
        });

        // If auto-block Sundays is enabled, block all future Sundays
        if (settings.autoBlockSundays) {
            blockFutureSundays();
        }

        res.json({
            success: true,
            message: 'Settings saved successfully',
            featuresActivated: {
                autoBlockSundays: settings.autoBlockSundays,
                requireDeposit: settings.requireDeposit,
                emailNotifications: settings.emailNotifications
            }
        });

    } catch (error) {
        console.error('Error saving admin settings:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Helper function to read admin settings
function readAdminSettings() {
    const fs = require('fs');
    if (fs.existsSync('admin-settings.json')) {
        const data = fs.readFileSync('admin-settings.json', 'utf8');
        return JSON.parse(data);
    }
    // Default settings  
    return {
        signatureServiceBuffer: true, // Toggle for 1-hour buffer after signature services
        facialBuffer: '30',
        browBuffer: '30',
        lashBuffer: '30',
        waxingBuffer: '30',
        specialtyBuffer: '30',
        autoBlockSundays: true,
        requireDeposit: false,
        emailNotifications: true
    };
}

// Helper function to block future Sundays (for auto-block Sundays feature)
function blockFutureSundays() {
    const fs = require('fs');
    let blockedTimes = readBlockedTimesFile();

    const allTimes = ['9:00 AM', '10:00 AM', '11:00 AM', '12:00 PM', '1:00 PM', '2:00 PM',
        '3:00 PM', '4:00 PM', '5:00 PM', '6:00 PM', '7:00 PM', '8:00 PM', '9:00 PM'];

    let sundaysBlocked = 0;

    // Block next 12 Sundays (3 months worth)
    for (let i = 0; i < 90; i++) {
        const date = new Date();
        date.setDate(date.getDate() + i);

        // Check if it's a Sunday (0 = Sunday)
        if (date.getDay() === 0) {
            const dateStr = date.toISOString().split('T')[0];

            allTimes.forEach(time => {
                // Only block if not already blocked
                if (!blockedTimes.some(bt => bt.date === dateStr && bt.time === time)) {
                    blockedTimes.push({
                        date: dateStr,
                        time: time,
                        blockedAt: new Date().toISOString(),
                        reason: 'auto-block-sunday',
                        autoBlocked: true
                    });
                }
            });
            sundaysBlocked++;
        }
    }

    if (sundaysBlocked > 0) {
        fs.writeFileSync('blocked-times.json', JSON.stringify(blockedTimes, null, 2));
        console.log(`🚫 AUTO-BLOCKED ${sundaysBlocked} FUTURE SUNDAYS`);
    }
}

// Helper functions to extract customer info from payment notes
function extractCustomerName(note) {
    if (!note) return null;

    // Look for patterns like "50% DEPOSIT for John Smith" or "John Smith -"
    const depositMatch = note.match(/deposit for ([A-Za-z ]+)/i);
    if (depositMatch) return depositMatch[1].trim();

    // Look for patterns like "booking for Jane Doe"
    const bookingMatch = note.match(/booking for ([A-Za-z ]+)/i);
    if (bookingMatch) return bookingMatch[1].trim();

    // Look for names at the start before " - "
    const dashMatch = note.match(/^([A-Za-z ]+) -/);
    if (dashMatch) return dashMatch[1].trim();

    return null;
}

function extractCustomerPhone(note) {
    if (!note) return null;

    // Look for phone number patterns
    const phoneMatch = note.match(/(\d{3}[-.\s]?\d{3}[-.\s]?\d{4})/);
    if (phoneMatch) return phoneMatch[1];

    return null;
}

function extractServiceName(note) {
    if (!note) return null;

    // Common service keywords
    const services = ['facial', 'brows', 'lashes', 'waxing', 'teeth', 'powder', 'tint', 'lift'];
    for (const service of services) {
        if (note.toLowerCase().includes(service)) {
            return service.charAt(0).toUpperCase() + service.slice(1);
        }
    }

    return null;
}

// API endpoint to get transactions 
app.get('/api/transactions', async (req, res) => {
    try {
        const { period = '2weeks' } = req.query;

        // Calculate date range based on period
        let beginTime = new Date();
        if (period === '2weeks') {
            beginTime.setDate(beginTime.getDate() - 14);
        } else if (period === '1month') {
            beginTime.setMonth(beginTime.getMonth() - 1);
        } else {
            beginTime.setDate(beginTime.getDate() - 7); // Default to 1 week
        }

        // Format date for Square API (RFC 3339 format)
        const beginTimeStr = beginTime.toISOString();

        console.log(`🔍 FETCHING TRANSACTIONS from ${beginTimeStr} to now`);

        const { paymentsApi } = squareClient;

        // List payments from Square - try minimal call first
        console.log('🔧 Attempting to list payments with minimal parameters...');
        const response = await paymentsApi.listPayments();

        if (response.result.payments) {
            const allTransactions = response.result.payments.map(payment => {
                // Handle BigInt conversion properly
                let amount = 0;
                if (payment.amountMoney && payment.amountMoney.amount) {
                    const amountValue = payment.amountMoney.amount;
                    amount = typeof amountValue === 'bigint'
                        ? Number(amountValue) / 100
                        : amountValue / 100;
                }

                return {
                    id: payment.id,
                    transactionId: payment.id, // Frontend expects transactionId
                    amount: amount, // Convert from cents to dollars
                    currency: payment.amountMoney ? payment.amountMoney.currency : 'USD',
                    status: payment.status,
                    date: payment.createdAt,
                    sourceType: payment.sourceType || 'CARD',
                    cardDetails: payment.cardDetails ? {
                        brand: payment.cardDetails.card?.cardBrand,
                        last4: payment.cardDetails.card?.last4
                    } : null,
                    receiptUrl: payment.receiptUrl,
                    note: payment.note || 'Beauty appointment booking',
                    createdDate: new Date(payment.createdAt),
                    // Extract customer info from note or other sources
                    customerName: extractCustomerName(payment.note) || 'Unknown Customer',
                    customerPhone: extractCustomerPhone(payment.note) || '',
                    serviceName: extractServiceName(payment.note) || 'Appointment'
                };
            });

            // SMART FILTERING: Show only refund-relevant transactions
            const now = new Date();

            const transactions = allTransactions.filter(transaction => {
                // Filter out FAILED/CANCELED transactions (can't refund these)
                if (transaction.status === 'FAILED' || transaction.status === 'CANCELED') {
                    console.log(`🚫 Filtering out ${transaction.status} transaction: ${transaction.id}`);
                    return false;
                }

                // Only show transactions from last 90 days (wide window for future appointments)
                const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
                if (transaction.createdDate < ninetyDaysAgo) {
                    console.log(`📅 Filtering out very old transaction (${transaction.createdDate.toDateString()}): ${transaction.id}`);
                    return false;
                }

                // Show APPOINTMENT-RELATED transactions (COMPLETED = future bookings that might need refunds)
                const note = transaction.note.toLowerCase();
                const isAppointment = note.includes('deposit') ||
                    note.includes('booking') ||
                    note.includes('appointment') ||
                    note.includes('beauty') ||
                    note.includes('facial') ||
                    note.includes('brow') ||
                    note.includes('lash') ||
                    note.includes('wax') ||
                    note.includes('teeth') ||
                    note.includes('whitening');

                if (isAppointment) {
                    console.log(`💅 Including APPOINTMENT transaction (${transaction.status}): ${transaction.id} - ${transaction.note}`);
                    return true;
                }

                // Filter out random non-appointment payments
                console.log(`❓ Filtering out non-appointment transaction: ${transaction.id} - ${transaction.note}`);
                return false;
            });

            console.log(`🔍 FILTERED: ${allTransactions.length} total → ${transactions.length} refund-relevant transactions`);

            // Sort transactions by creation date (newest first)
            transactions.sort((a, b) => b.createdAt - a.createdAt);

            console.log(`📊 FOUND ${transactions.length} transactions in last ${period}`);

            res.json({
                success: true,
                transactions: transactions,
                count: transactions.length,
                period: period
            });
        } else {
            console.log('⚠️ No transactions found');
            res.json({
                success: true,
                transactions: [],
                count: 0,
                period: period
            });
        }

    } catch (error) {
        console.error('❌ ERROR FETCHING TRANSACTIONS:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch transactions: ' + error.message,
            transactions: []
        });
    }
});

// API endpoint to process refunds 
app.post('/api/process-refund', async (req, res) => {
    const fs = require('fs');
    const { bookingId, refundType, refundReason } = req.body; // refundType: 'full', 'partial', 'none'

    try {
        // Find the booking
        let bookings = readBookingsFile();
        const booking = bookings.find(b => b.id === bookingId);

        if (!booking) {
            return res.status(404).json({ success: false, error: 'Booking not found' });
        }

        if (booking.refundStatus !== 'none') {
            return res.status(400).json({ success: false, error: 'Booking has already been refunded' });
        }

        let refundAmount = 0;

        // Calculate refund amount based on type
        if (refundType === 'full') {
            refundAmount = Math.round(booking.depositPaid * 100); // Convert to cents for Square
        } else if (refundType === 'partial') {
            refundAmount = Math.round(booking.depositPaid * 0.5 * 100); // 50% of deposit in cents
        }

        let refundResult = null;

        // Process refund via Square API if amount > 0
        if (refundAmount > 0) {
            try {
                const { refundsApi } = squareClient;

                const refundRequest = {
                    idempotencyKey: `refund-${bookingId}-${Date.now()}`,
                    amountMoney: {
                        amount: refundAmount,
                        currency: 'USD'
                    },
                    paymentId: booking.paymentId,
                    reason: refundReason || `${refundType} refund for booking ${bookingId}`
                };

                const refundResponse = await refundsApi.refundPayment(refundRequest);
                refundResult = refundResponse.result.refund;

                console.log('💸 SQUARE REFUND PROCESSED:', {
                    refundId: refundResult.id,
                    amount: `$${(refundAmount / 100).toFixed(2)}`,
                    status: refundResult.status,
                    customer: booking.customerName
                });

            } catch (refundError) {
                console.error('Square refund failed:', refundError);
                return res.status(500).json({
                    success: false,
                    error: 'Failed to process refund via Square',
                    details: refundError.message
                });
            }
        }

        // Update booking record
        const refundAmountInDollars = refundAmount / 100;
        booking.refundStatus = refundType;
        booking.refundAmount = refundAmountInDollars;
        booking.refundProcessedAt = new Date().toISOString();
        booking.refundReason = refundReason || `${refundType} refund`;
        booking.refundId = refundResult?.id || 'no-refund';

        // Recalculate remaining balance after refund
        if (refundType === 'full') {
            booking.remainingBalance = booking.totalAmount; // Customer owes full amount now
            booking.status = 'CANCELLED';
        } else if (refundType === 'partial') {
            booking.remainingBalance = booking.totalAmount - (booking.depositPaid - refundAmountInDollars);
        }

        // Save updated bookings
        fs.writeFileSync('bookings.json', JSON.stringify(bookings, null, 2));

        // Send refund notification email to Mary
        try {
            const https = require('https');
            const querystring = require('querystring');

            const emailData = querystring.stringify({
                '_subject': '💸 REFUND PROCESSED',
                'customer_name': booking.customerName,
                'customer_phone': booking.customerPhone,
                'customer_email': booking.customerEmail,
                'refund_type': refundType.toUpperCase(),
                'refund_amount': `$${refundAmountInDollars.toFixed(2)}`,
                'original_deposit': `$${booking.depositPaid.toFixed(2)}`,
                'remaining_balance': `$${booking.remainingBalance.toFixed(2)}`,
                'appointment_date': new Date(booking.date).toLocaleDateString(),
                'appointment_time': booking.time,
                'refund_reason': refundReason || 'Admin processed',
                'refund_id': refundResult?.id || 'N/A',
                '_template': 'box'
            });

            const options = {
                hostname: 'formspree.io',
                port: 443,
                path: '/f/xpwlqjnv',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': Buffer.byteLength(emailData),
                    'Accept': 'application/json'
                }
            };

            const emailReq = https.request(options, (emailRes) => {
                console.log('📧 Refund notification sent to Mary');
            });

            emailReq.on('error', (error) => {
                console.error('Refund email notification failed:', error);
            });

            emailReq.write(emailData);
            emailReq.end();

        } catch (emailError) {
            console.error('Refund email error:', emailError);
        }

        console.log('✅ REFUND PROCESSED SUCCESSFULLY:', {
            customer: booking.customerName,
            refundType: refundType.toUpperCase(),
            refundAmount: `$${refundAmountInDollars.toFixed(2)}`,
            remainingBalance: `$${booking.remainingBalance.toFixed(2)}`,
            status: booking.status
        });

        res.json({
            success: true,
            refund: {
                type: refundType,
                amount: refundAmountInDollars,
                remainingBalance: booking.remainingBalance,
                status: booking.status
            },
            message: `${refundType} refund processed successfully`
        });

    } catch (error) {
        console.error('Error processing refund:', error);
        res.status(500).json({ success: false, error: 'Failed to process refund' });
    }
});

// API endpoint to clear all bookings (for testing)
app.post('/api/clear-bookings', (req, res) => {
    const fs = require('fs');

    try {
        // Clear bookings file
        if (fs.existsSync('bookings.json')) {
            fs.writeFileSync('bookings.json', '[]');
        }

        // Clear blocked times file  
        if (fs.existsSync('blocked-times.json')) {
            fs.writeFileSync('blocked-times.json', '[]');
        }

        // Clear personal events file
        if (fs.existsSync('personal-events.json')) {
            fs.writeFileSync('personal-events.json', '[]');
        }

        console.log('✅ ALL BOOKINGS, BLOCKED TIMES, AND PERSONAL EVENTS CLEARED');
        res.json({ success: true, message: 'All bookings cleared successfully' });

    } catch (error) {
        console.error('Error clearing bookings:', error);
        res.status(500).json({ success: false, error: 'Failed to clear bookings' });
    }
});

// Start server
// API endpoint for transaction-based refunds (called from Analytics tab)
app.post('/api/refund', async (req, res) => {
    const { transactionId, amount, type } = req.body;

    try {
        console.log(`💸 PROCESSING ${type.toUpperCase()} REFUND:`, {
            transactionId,
            amount: `$${amount}`,
            type
        });

        // Convert amount to cents for Square API
        const refundAmountCents = Math.round(amount * 100);

        const { refundsApi } = squareClient;

        const refundRequest = {
            idempotencyKey: `transaction-refund-${transactionId}-${Date.now()}`,
            amountMoney: {
                amount: refundAmountCents,
                currency: 'USD'
            },
            paymentId: transactionId,
            reason: `${type} refund of $${amount} via admin panel`
        };

        console.log('🔄 Sending refund request to Square API...');
        const refundResponse = await refundsApi.refundPayment(refundRequest);
        const refundResult = refundResponse.result.refund;

        console.log('✅ SQUARE REFUND SUCCESS:', {
            refundId: refundResult.id,
            amount: `$${amount}`,
            status: refundResult.status,
            transactionId
        });

        res.json({
            success: true,
            refundId: refundResult.id,
            status: refundResult.status,
            amount: amount,
            message: `${type} refund of $${amount} processed successfully`
        });

    } catch (error) {
        console.error('❌ REFUND FAILED:', error);

        let errorMessage = 'Failed to process refund';
        if (error.errors && error.errors.length > 0) {
            errorMessage = error.errors[0].detail || errorMessage;
        }

        res.status(500).json({
            success: false,
            error: errorMessage,
            details: error.message
        });
    }
});

// Save customer card for future use
async function saveCustomerCard(token, customerId) {
    try {
        const { result } = await squareClient.cardsApi.createCard({
            idempotencyKey: `card-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            sourceId: token,
            card: {
                customerId: customerId
            }
        });

        console.log('💳 Card saved with ID:', result.card.id);
        return result.card;
    } catch (error) {
        console.error('❌ Failed to save card:', error);
        throw error;
    }
}

// Add error handling to prevent crashes
process.on('uncaughtException', (error) => {
    console.error('🚨 UNCAUGHT EXCEPTION - Server staying up:', error.message);
    console.error('Stack:', error.stack);
    // Don't exit - let PM2 handle restarts if needed
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('🚨 UNHANDLED REJECTION - Server staying up:', reason);
    console.error('Promise:', promise);
    // Don't exit - let PM2 handle restarts if needed
});

// Graceful shutdown handling
process.on('SIGTERM', () => {
    console.log('👋 SIGTERM received, shutting down gracefully');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('👋 SIGINT received, shutting down gracefully');
    process.exit(0);
});

const server = app.listen(PORT, '0.0.0.0', () => {
    console.log('🚀 =================================');
    console.log('🚀   MARY\'S BOOKING SYSTEM ONLINE');
    console.log('🚀 =================================');
    console.log(`✅ Server running on http://localhost:${PORT}`);
    console.log(`✅ Network access: http://10.0.0.85:${PORT}`);
    console.log(`📱 Customer site: http://10.0.0.85:${PORT}`);
    console.log(`🔧 Admin panel: http://10.0.0.85:${PORT}/admin`);
    console.log('🛡️  Auto-restart enabled via PM2');
    console.log('🛡️  Error protection active');
    console.log('⏰ Server started at:', new Date().toLocaleString());
    console.log('🚀 =================================');
});

// Keep server alive and handle timeouts
server.keepAliveTimeout = 120000; // 2 minutes
server.headersTimeout = 120000;   // 2 minutes

// Periodic health check
setInterval(() => {
    const memUsage = process.memoryUsage();
    console.log(`💚 Server healthy - Memory: ${Math.round(memUsage.rss / 1024 / 1024)}MB - ${new Date().toLocaleString()}`);
}, 300000); // Every 5 minutes

module.exports = app; 