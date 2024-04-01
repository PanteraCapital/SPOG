Element.prototype.addClass = function(className) {
    if (this.classList) {
        this.classList.add(className);
    } else {
        var currentClasses = this.className.split(' ');
        if (currentClasses.indexOf(className) === -1) {
            currentClasses.push(className);
            this.className = currentClasses.join(' ');
        }
    }
};

Element.prototype.removeClass = function(className) {
    if (this.classList) {
        this.classList.remove(className);
    } else {
        var currentClasses = this.className.split(' ');
        var index = currentClasses.indexOf(className);
        if (index !== -1) {
            currentClasses.splice(index, 1);
            this.className = currentClasses.join(' ');
        }
    }
};

Element.prototype.hasClass = function(className) {
    if (this.classList) {
        return this.classList.contains(className);
    } else {
        return this.className.split(' ').indexOf(className) !== -1;
    }
};


if (navigator.geolocation) {
  navigator.geolocation.getCurrentPosition((position) => {
    const latitude = position.coords.latitude;
    const longitude = position.coords.longitude;

    console.log(`${latitude},${longitude}`);
    document.getElementById('user-location').innerText = `${latitude},${longitude}`;
  });
}


function loadPage(targetValue) {
    var overlay = document.getElementById('overlay');
    var loading = overlay.querySelector('progress');

    // Ensure the overlay is visible
    if (overlay.classList.contains('d-none')) {
        overlay.classList.remove('d-none');
    }

    // Recursive function to increment loading.value by 10 every 200 milliseconds
    function incrementStep(currentStep) {
        setTimeout(function () {
            currentStep += 10;
            loading.value = Math.min(currentStep, targetValue); // Ensure we don't exceed the targetValue

            if (currentStep < targetValue) {
                incrementStep(currentStep);
            } else {
                // When reaching the targetValue, perform additional actions
                if (targetValue === 100) {
                    setTimeout(function () {
                        overlay.style.opacity = 0;
                        setTimeout(function () {
                            overlay.classList.add('d-none');
                            overlay.style.opacity = 1;
                            loading.value = 0;
                        }, 300);
                    }, 100);
                }
            }
        }, 10);
    }

    // Start the incrementing process from 0
    incrementStep(parseInt(loading.value));
}
