(function () {
    'use strict';
    var form = document.getElementById('checkout-form');
    var button = document.getElementById('razorpay-pay');
    var cancelButton = document.getElementById('razorpay-cancel');
    var status = document.getElementById('payment-status');
    if (!form || !button || !status) return;

    var pendingPayment = null;
    function show(message) {
        status.textContent = message;
        status.hidden = !message;
    }
    function csrf() {
        var field = form.querySelector('[name="_csrf"]');
        return field ? field.value : '';
    }
    function postJson(url, payload) {
        return fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrf() },
            body: JSON.stringify(payload)
        }).then(function (response) {
            return response.json().then(function (data) {
                if (!response.ok) throw new Error(data.error || 'The payment request failed.');
                return data;
            });
        });
    }
    function cancelOrder(orderId) {
        return postJson(form.dataset.cancelUrl, { order_id: orderId });
    }
    if (cancelButton) {
        cancelButton.addEventListener('click', function () {
            cancelButton.disabled = true;
            cancelOrder(form.dataset.pendingOrderId).then(function () {
                window.location.reload();
            }).catch(function (error) {
                cancelButton.disabled = false;
                show('Could not cancel the pending payment: ' + error.message);
            });
        });
    }
    function verifyPayment(payment) {
        return postJson(form.dataset.verifyUrl, {
            razorpay_payment_id: payment.razorpay_payment_id,
            razorpay_order_id: payment.razorpay_order_id,
            razorpay_signature: payment.razorpay_signature
        }).then(function (data) {
            window.location.assign(data.redirect_url);
        }).catch(function (error) {
            show(error.message + ' If payment was deducted, retry verification or contact support.');
            button.disabled = false;
        });
    }
    button.addEventListener('click', function () {
        if (!form.reportValidity()) return;
        if (pendingPayment) {
            button.disabled = true;
            verifyPayment(pendingPayment);
            return;
        }
        button.disabled = true;
        show('Connecting to Razorpay…');
        postJson(form.dataset.createUrl, {
            token: form.querySelector('[name="token"]').value,
            address: form.querySelector('[name="address"]').value
        }).then(function (order) {
            show('');
            var checkout = new Razorpay({
                key: form.dataset.keyId,
                amount: order.amount,
                currency: order.currency,
                name: 'OrderFood',
                description: 'Food order',
                order_id: order.order_id,
                handler: function (payment) {
                    pendingPayment = payment;
                    show('Verifying your payment…');
                    verifyPayment(payment);
                },
                prefill: { email: form.dataset.email || '' },
                modal: {
                    ondismiss: function () {
                        button.disabled = false;
                        if (!pendingPayment) {
                            cancelOrder(order.order_id).then(function () {
                                show('Payment cancelled. You have not placed an order.');
                            }).catch(function (error) {
                                show('Payment cancelled, but the checkout session could not be cleared: ' + error.message);
                            });
                        }
                    }
                },
                theme: { color: '#1f5c47' }
            });
            checkout.on('payment.failed', function (event) {
                button.disabled = false;
                var message = event.error && event.error.description ?
                    event.error.description : 'Payment failed. Please try again.';
                cancelOrder(order.order_id).then(function () {
                    show(message);
                }).catch(function (error) {
                    show(message + ' The checkout session could not be cleared: ' + error.message);
                });
            });
            checkout.open();
        }).catch(function (error) {
            button.disabled = false;
            show(error.message);
        });
    });
})();
