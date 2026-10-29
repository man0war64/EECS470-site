// [width, height]
var std_image_width = 528;
var std_image_height = 814;

var labels = {};
var simulation_running = false;
var pc;
var data_start;

var colors = ["#6DCFBE", "#95BA9A", "#FEDD95", "#b9b9c6", "#F489B4"];

// (x1, y1) = top left corner
// (x2, y2) = bottom right corner
// [x1, y1, x2, y2]
var registers = [
                      {object: $("#reg0"), location: [295,  12, 480, 100]},
                      {object: $("#reg1"), location: [295, 112, 480, 200]},
                      {object: $("#reg2"), location: [295, 212, 480, 302]},
                      {object: $("#reg3"), location: [295, 314, 480, 405]},
                      {object: $("#reg4"), location: [295, 417, 480, 505]},
                      {object: $("#reg5"), location: [295, 517, 480, 606]},
                      {object: $("#reg6"), location: [295, 618, 480, 708]},
                      {object: $("#reg7"), location: [295, 720, 480, 810]},
                      {object: $("#reg8"), location: [295, 822, 480, 810]},
                      {object: $("#reg9"), location: [295, 922, 480, 810]},
                      {object: $("#reg10"), location: [295, 1022, 480, 810]},
                      {object: $("#reg11"), location: [295, 1124, 480, 810]},
                      {object: $("#reg12"), location: [295, 1227, 480, 810]},
                      {object: $("#reg13"), location: [295, 1327, 480, 810]},
                      {object: $("#reg14"), location: [295, 1428, 480, 810]},
                      {object: $("#reg15"), location: [295, 1530, 480, 810]}
                      ];

var default_state = {pc_reg: 0,
              reg0: 0,
              reg1: 0,
              reg2: 0,
              reg3: 0,
              reg4: 0,
              reg5: 0,
              reg6: 0,
              reg7: 0,
              reg8: 0,
              reg9: 0,
              reg10: 0,
              reg11: 0,
              reg12: 0,
              reg13: 0,
              reg14: 0,
              reg15: 0
              };

var state = Object.assign({}, default_state);
var next_state = Object.assign({}, default_state);
var auto_interval;
var auto_timer = -1;
var insts_executed = 0;

$( "#step-button" ).click(function() {
    if ($("#step-button").hasClass("disabled")) {
        return;
    }
    exeCycleWrapper();
})

$( "#auto-step-button" ).click(function() {
    if ($( "#auto-step-button" ).hasClass("disabled"))
        return;

    if (auto_timer == -1) {
        // start
        auto_interval = 750;
        auto_timer = setInterval(exeCycleWrapper, auto_interval);
        $( "#auto-stop-button" ).show();
    } else {
        // speed up
        if (auto_interval > 10) {
            clearInterval(auto_timer);
            auto_interval = Math.round(auto_interval * 1 / 2);
            auto_timer = setInterval(exeCycleWrapper, auto_interval);
        }
    }
});

function exeCycleWrapper() {
    try {
        exeCycle();
    } catch(err) {
        $( "#verify-button" ).attr("class", "btn btn-danger");
        $( "#verify-button" ).html("Verify");
        $( "#text-console" ).html("<strong>RUNTIME ERROR</strong><br>" + err);
        $( "#text-console" ).css("background-color", "#F0D9D9");
        endSimulation();
    }
}

$( "#auto-stop-button" ).click(function() {
    stopAutoStep();
});

function stopAutoStep() {
    $( "#auto-stop-button" ).hide();

    if (auto_timer != -1) {
        clearInterval(auto_timer);
        auto_timer = -1;
    }
}

$( "#instruction-memory-assembly" ).keydown(function(e) {
    if(simulation_running)
        endSimulation();

    // Firefox inserts \n<br> on return key, Chrome inserts \n
    // need to handle Firefox separately
    var isFirefox = (navigator.userAgent.toLowerCase().indexOf('firefox') > -1);

    if (e.keyCode == 13 && isFirefox) {
        // trap the return key being pressed
        e.preventDefault();

        var doc = this.ownerDocument.defaultView;
        var sel = doc.getSelection();
        var range = sel.getRangeAt(0);
        // if user selected some text, remove it first
        range.deleteContents();

        // https://stackoverflow.com/questions/7901350/how-to-force-br-line-break-in-firefox-contenteditable
        var node = sel.anchorNode;
        var offset = sel.anchorOffset;
        var text = node.textContent;
        // modify text in div
        textBefore = text.slice(0, offset);
        textAfter = text.slice(offset) || ' ';
        node.textContent = textBefore + '\n' + textAfter;

        // set cursor to new line
        range.setStart(node, offset + 1);
        range.setEnd(node, offset + 1);
        sel.removeAllRanges();
        sel.addRange(range);
    } else if (e.keyCode === 9) {
        // trap tab key
        e.preventDefault();

        // now insert four non-breaking spaces for the tab key
        var doc = this.ownerDocument.defaultView;
        var sel = doc.getSelection();
        var range = sel.getRangeAt(0);

        var tabNode = document.createTextNode("\u00a0\u00a0\u00a0\u00a0");
        range.insertNode(tabNode);

        range.setStartAfter(tabNode);
        range.setEndAfter(tabNode); 
        sel.removeAllRanges();
        sel.addRange(range);
    } 
});

$("#verify-button").click(function() {
    insts_executed = 0;
    if (simulation_running) {
        $( "#verify-button" ).attr("class", "btn btn-primary");
        $( "#verify-button" ).html("Verify");
        endSimulation();
    }
    else{
        assembleInstructions();
    }
});

function initialize() {
    setControlObjectHeights();
    setRegPos();
}

$( window ).resize(function() {
    setControlObjectHeights();
    setRegPos();
});

$( window ).scroll(function() {
    setRegPos();
});

function setControlObjectHeights() {
    var inst_memory = $("#instruction-memory-assembly");
    var data_memory = $("#data-memory");
    var text_console = $("#text-console");
    var memory_space = window.innerHeight - inst_memory.offset().top - 50;
    var console_space = window.innerHeight - text_console.offset().top - 25;

    inst_memory.height(memory_space);
    data_memory.height(memory_space);
    text_console.height(console_space);
}

function setRegPos() {
    var reg_pos;
    var reg_width;
    var reg_height;

    for (var i = 0; i < 16; i++) {
        reg_pos = getRegPos(registers[i].location);
        reg_width = reg_pos[2] - reg_pos[0];
        reg_height = reg_pos[3] - reg_pos[1];

        registers[i].object.css('top', reg_pos[1]);
        registers[i].object.css('left', reg_pos[0]);
        registers[i].object.width(reg_width);
        registers[i].object.height(reg_height);
    }
}

function getRegPos(p_reg) {
    var image_position = $("#regfile-image").offset();
    var image_height = $("#regfile-image").height();
    var image_width = $("#regfile-image").width();
    var scroll_pos = $( document ).scrollTop();

    var h_mult = image_height / std_image_height;
    var w_mult = image_width / std_image_width;

    var p_reg_out = new Array(4);

    p_reg_out[0] = w_mult * p_reg[0];
    p_reg_out[1] = h_mult * p_reg[1];
    p_reg_out[2] = w_mult * p_reg[2];
    p_reg_out[3] = h_mult * p_reg[3];

    p_reg_out[0] += image_position.left;
    p_reg_out[1] += image_position.top - scroll_pos;
    p_reg_out[2] += image_position.left;
    p_reg_out[3] += image_position.top - scroll_pos;

    return p_reg_out;
}

function getMem(objectID) {
    var instString = $(objectID).html();
    
    if (navigator.userAgent.toLowerCase().indexOf('firefox') > -1) {
        instString = instString.replace(/<br\s*[\/]?>/gi, "\n");
        instString = instString.replace(/<div>/gi, "");
        instString = instString.replace(/<[\/]div>/gi, "\n");
    }

    instString = stripHTML(instString);

    var arrayOfInsts = new Array();

    arrayOfInsts = instString.split(/\r?\n/);

    return arrayOfInsts;
}

function assembleInstructions() {
    var parsedLine;
    var arrayOfInst = new Array();
    var errorMessage = "";
    var error = false;
    var i;
    var pass;
    var data = new Array();
    var hasLabel;
    var opcode, arg0, arg1, arg2;
    var haltFound = false;

    labels = {};
    data_start = -1;
    arrayOfInst = getMem("#instruction-memory-assembly");

    for (pass = 1; pass <= 2; pass++) {
        for (i = 0; i < arrayOfInst.length; i++) {
            parsedLine = arrayOfInst[i].match(/\S+/g);

            // check if blank line 
            if (parsedLine == null) {
                if (arrayOfInst.length == 1) {
                    error = true;
                    arrayOfInst[i] = highlightLine(arrayOfInst[i], 'red');
                    errorMessage += i.toString() + ": no instructions<br>";
                    break;
                } else {
                    continue;
                }
            } else if (pass == 1) {
                hasLabel = isAlpha(arrayOfInst[i][0]);

                if (hasLabel && !logLabel(parsedLine[0], i)) {
                    error = true;
                    arrayOfInst[i] = highlightLine(arrayOfInst[i], 'red');
                    errorMessage += i.toString() + ": duplicate label<br>";
                    break;
                }
            } else {
                hasLabel = isAlpha(arrayOfInst[i][0]);

                if (hasLabel) {
                    opcode = parsedLine[1];
                    arg0 = parsedLine[2];
                    arg1 = parsedLine[3];
                    arg2 = parsedLine[4];
                } else {
                    opcode = parsedLine[0];
                    arg0 = parsedLine[1];
                    arg1 = parsedLine[2];
                    arg2 = parsedLine[3];
                }

                try {
                    if (typeof opcode == "undefined") {
                        throw "undefined opcode";
                    } else if (opcode == ".fill") {
                        if (!haltFound) {
                            throw ".fill before halt";
                        }
                        if (data_start == -1)
                            data_start = i;
                        if (isNaN(arg0)) {
                            if (arg0 in labels) {
                                arg0 = labels[arg0];
                            } else {
                                throw "undefined label";
                            }
                        }
                        data.push(i.toString() + ": " + arg0);
                    } else {
                        if (opcode == "halt") {
                            haltFound = true;
                        }
                    }
                } catch(message) {
                    error = true;
                    arrayOfInst[i] = highlightLine(arrayOfInst[i], 'red');
                    errorMessage += i.toString() + ": " + message + "<br>";
                    break;
                }
            }
        }
    }

    if (!haltFound && error == false) {
        error = true;
        errorMessage += arrayOfInst.length.toString() + ": no halt instruction<br>";
    }

    if (error) {
        $( "#verify-button" ).attr("class", "btn btn-danger");
        $( "#verify-button" ).html("Verify");
        $( "#text-console" ).html("<strong>ERROR</strong><br>" + errorMessage);
        $( "#text-console" ).css("background-color", "#F0D9D9");
        instVerified = false;
    } else {
        $( "#verify-button" ).attr("class", "btn btn-default");
        $( "#verify-button" ).html("Reset");

        $( "#step-button" ).attr("class", "btn btn-success");
        $( "#auto-step-button" ).attr("class", "btn btn-success");

        $( "#text-console" ).html("");
        $( "#text-console" ).css("background-color", "");

        simulation_running = true;

        if (data_start == -1){
            data_start = arrayOfInst.length;
            data.push(data_start.toString() + ": " + 0);
        }

        $("#data-memory").html(combineMem(data));

        state = Object.assign({}, default_state);
        next_state = Object.assign({}, default_state);
        arrayOfInst[0] = highlightLine(arrayOfInst[0], 'green');
        updateRegs();
    } 

    $("#instruction-memory-assembly").html(combineMem(arrayOfInst));
}

function convertArg(arg, offset = false, beqInst = false, line = 0) {
    var convArg;

    if (typeof arg == "undefined") {
        throw "undefined argument";
    } else if (offset) {
        if (isNaN(arg)) {
            if (arg in labels) {
                convArg = labels[arg];
            } else {
                throw "undefined label";
            }

            if (beqInst) {
                convArg -= (line + 1);
            }
        } else {
            convArg = parseInt(arg);

            if (convArg < -524288 || convArg > 524287) {
                throw "offset out of bounds";
            }
        }
    } else {
        if (isNaN(arg)) {
            throw "register argument not a number";
        } else {
            convArg = parseInt(arg);

            if (convArg > 15 || convArg < 0) {
                throw "register arguement out of bounds";
            }
        }
    }

    return convArg;
}

function logLabel(label, line) {
    if (label in labels) {
        // label already exists, throw error
        return false;
    } else {
        labels[label] = line;
        return true;
    }
}

function getCaretCharacterOffsetWithin(element) {
    var caretOffset = 0;
    var doc = element.ownerDocument || element.document;
    var win = doc.defaultView || doc.parentWindow;
    var sel;
    if (typeof win.getSelection != "undefined") {
        sel = win.getSelection();
        if (sel.rangeCount > 0) {
            var range = win.getSelection().getRangeAt(0);
            var preCaretRange = range.cloneRange();
            preCaretRange.selectNodeContents(element);
            preCaretRange.setEnd(range.endContainer, range.endOffset);
            caretOffset = preCaretRange.toString().length;
        }
    } else if ( (sel = doc.selection) && sel.type != "Control") {
        var textRange = sel.createRange();
        var preCaretTextRange = doc.body.createTextRange();
        preCaretTextRange.moveToElementText(element);
        preCaretTextRange.setEndPoint("EndToEnd", textRange);
        caretOffset = preCaretTextRange.text.length;
    }
    return caretOffset;
}

function stripHTML(inputStr) {
    var tmp = document.createElement("DIV");

    var no_encoded_carrots = inputStr.replace(/&lt;/gi, "<");
    no_encoded_carrots = no_encoded_carrots.replace(/&gt;/gi, ">");
    tmp.innerHTML = no_encoded_carrots;

    return tmp.textContent || tmp.innerText;
}

function highlightLine(line, color) {
    var color_num;
    if (color == "yellow") {
        color_num = "#FCF7DF";
    } else if (color == "red") {
        color_num = "#F0D9D9";
    } else if (color == "green") {
        color_num = "#DBEED3";
    } else if (color == "blue") {
        color_num = "#D4EAF6";
    } else if (color == "orange") {
        color_num = "#f4b042";
    } else {
        color_num = color;
    }

    return "<span style =\"background-color: " + color_num + "; border-radius: 2px;\">" + line  + "</span>";
}

function isAlpha(str) {
  return str.length === 1 && str.match(/[a-z]/i);
}

function combineMem(instArray) {
    var i;
    var combinedInst = new Array();
    for (i = 0; i < instArray.length; i++) {
        combinedInst.push(instArray[i]);
        if (i != instArray.length - 1) {
            if (navigator.userAgent.toLowerCase().indexOf('firefox') > -1) {
                combinedInst.push("<br>");
            } else {
                combinedInst.push("\n");
            }
        }
    }

    return combinedInst;
}

function updateRegs() {
    $(".register-file").css('font-size', $(".register-file").first().height() * 0.65);
    for (var i = 0; i < 16; i++) {
        var new_val = state[registers[i].object.attr('id')];
        registers[i].object.html(new_val);
        if(new_val>999999 || new_val < -99999){
            registers[i].object.css('font-size', $(".register-file").first().height() * 0.36);
        }
    }
}

function exeCycle() {
    var arrayOfInst = new Array();
    var parsed_line;
    var pc = parseInt(state["pc_reg"]);
    var opcode;
    var arg0;
    var arg1;
    var arg2;
    var addr;

    arrayOfInst = getMem("#instruction-memory-assembly");

    parsed_line = arrayOfInst[pc].match(/\S+/g);
    hasLabel = isAlpha(arrayOfInst[pc][0]);

    if (hasLabel) {
        opcode = parsed_line[1];
        arg0 = parsed_line[2];
        arg1 = parsed_line[3];
        arg2 = parsed_line[4];
    } else {
        opcode = parsed_line[0];
        arg0 = parsed_line[1];
        arg1 = parsed_line[2];
        arg2 = parsed_line[3];
    }


    pc = pc + 1;

    if(arg0 != "undefined"){
        val_a = parseInt(state["reg" + arg0]);
        val_b = parseInt(state["reg" + arg1]);
    }

    insts_executed++;
    if (opcode == "halt") {
        $( "#text-console" ).html("<strong>Machine Halted after "+insts_executed+" instructions</strong>");
        $( "#text-console" ).css("background-color", "#DBEED3");
        endSimulation();
        return;
    } else if (opcode == "noop") {
        
    } else if (opcode == ".fill") {
        throw ".fill is not an instruction!";
    } else if (opcode == "b") {
        pc = pc + convertArg(arg0, true, true, pc-1);
    } else if (Number.isNaN(val_a) || Number.isNaN(val_b)) {
        throw "Invalid register!";
    } else if (opcode == "add") {
        state["reg" + arg2] = val_a + val_b;
    } else if (opcode == "nor") {
        state["reg" + arg2] = ~(val_a | val_b);
    } else if (opcode == "nand") {
        state["reg" + arg2] = ~(val_a & val_b);
    } else if (opcode == "lw") {
        addr = val_a + convertArg(arg2, true);
        state["reg" + arg1] = accessData(addr, "load");
    } else if (opcode == "addi") {
        state["reg" + arg1] = val_a + convertArg(arg2, true);
    } else if (opcode == "sw") {
        addr = val_a + convertArg(arg2, true);
        accessData(addr, "store", val_b);
    } else if (opcode == "beq") {
        if (val_a == val_b) {
            pc = pc + convertArg(arg2, true, true, pc-1);
        }
    } else if (opcode == "jalr") {
        state["reg" + arg1] = pc;
        if(arg1 != arg0){
            pc = val_a;
        }
    }

    state["pc_reg"] = pc;

    if (pc >= arrayOfInst.length || pc < 0) {
        throw "PC out of bounds of instruction memory!";
    }

    if (pc>= 0 && pc < arrayOfInst.length) {
        arrayOfInst[pc] = highlightLine(arrayOfInst[pc], 'green');
    }
    $("#instruction-memory-assembly").html(combineMem(arrayOfInst));

    updateRegs();
    $("#text-console").html("Instructions executed: "+insts_executed);
}

function accessData(address, request, data = 0) {
    var index = address - data_start;
    var data_mem = getMem("#data-memory");
    var index = address - data_start;
    var parsed_line;

    if (data_start == -1 || index < 0) {
        var err_string = "address " + address.toString() + " not in Data Memory!";
        throw err_string;
        return;
    }

    if (request == "load") {
        if(index >= data_mem.length){
            return 0;
        }
        parsed_line = data_mem[index].match(/\S+/g);
        return parseInt(parsed_line[1]);
    } else {
        while(index >= data_mem.length){
            data_mem.push((data_start + data_mem.length).toString() + ": " + 0);
        }
        data_mem[index] = (data_start+index).toString() + ": " + data.toString();
        $("#data-memory").html(combineMem(data_mem));
        return 0;
    }
}

function endSimulation() {
    var arrayOfInst = new Array();
    arrayOfInst = getMem("#instruction-memory-assembly");

    simulation_running = false;
    $("#instruction-memory-assembly").html(combineMem(arrayOfInst));
    $( "#verify-button" ).attr("class", "btn btn-primary");
    $( "#verify-button" ).html("Verify");
    stopAutoStep();
    $("#auto-stop-button").hide();
    $( "#auto-step-button" ).attr("class", "btn btn-success disabled");
    $("#step-button").attr("class", "btn btn-success disabled");
}

$( "#load-instructions" ).change(function() {
    var value = $( "#load-instructions" ).val();
    var inst = new Array();

    if (value == "Load Instructions") {
        return;
    } else if (value == "2D Array[i][j] (good)") {
        inst.push("     addi   0   5   40    //i bound");
        inst.push("     addi   0   7   8     //j bound, i step");
        inst.push("     addi   0   6   1     //j step");
        inst.push("fori beq    1   5   endi  //is i == 40?");
        inst.push("     addi   0   2   0     //j = 0");
        inst.push("forj beq    2   7   endj  //is j == 8?");
        inst.push("     add    1   2   3     //temp = i + j");
        inst.push("     lw     3   3   64    //load i + j");
        inst.push("     add    2   6   2     //incr j");
        inst.push("     beq    0   0   forj  //loop");
        inst.push("endj add    1   7   1     //incr i");
        inst.push("     beq    0   0   fori  //loop");
        inst.push("endi halt");
    } else if (value == "2D Array[i][j] (bad)") {
        inst.push("     addi   0   5   40    //i bound");
        inst.push("     addi   0   7   8     //j bound, i step");
        inst.push("     addi   0   6   1     //j step");
        inst.push("forj beq    2   7   endj  //is j == 8?");
        inst.push("     addi   0   1   0     //i = 0");
        inst.push("fori beq    1   5   endi  //is i == 40?");
        inst.push("     add    1   2   3     //temp = i + j");
        inst.push("     lw     3   3   64    //load i + j");
        inst.push("     add    1   7   1     //incr i");
        inst.push("     beq    0   0   fori  //loop");
        inst.push("endi add    2   6   2     //incr j");
        inst.push("     beq    0   0   forj  //loop");
        inst.push("endj halt");
    } else if (value == "Project 1 Spec") {
        inst.push("	lw	0	1	five");
        inst.push("	lw	1	2	3");
        inst.push("start	add	1	2	1");
        inst.push("	beq	0	1	2");
        inst.push("	beq	0	0	start");
        inst.push("	noop");
        inst.push("done	halt");
        inst.push("five	.fill	5");
        inst.push("neg1	.fill	-1");
        inst.push("stAddr	.fill	start");
    } else if (value == "Project 2 Spec") {
        inst.push("	lw	0	1	five");
        inst.push("	lw	0	4	SubAdr");
        inst.push("start	jalr	4	7");
        inst.push("	beq	0	1	done");
        inst.push("	beq	0	0	start");
        inst.push("done	halt");
        inst.push("subOne	lw	0	2	neg1");
        inst.push("	add	1	2	1");
        inst.push("	jalr	7	6");
        inst.push("five	.fill	5");
        inst.push("neg1	.fill	-1");
        inst.push("SubAdr	.fill	subOne");
    } else if (value == "Project 3 Spec") {
        inst.push("	lw	0	1	data1");
        inst.push("	halt");
        inst.push("data1	.fill	12345");
    } else if (value == "Project 4 Spec") {
        inst.push("	sw	0	1	6");
        inst.push("	lw	0	1	23");
        inst.push("	lw	0	1	30");
        inst.push("	halt");
    }
    updateInstructions(inst);
    endSimulation();
});

function updateInstructions(arrayOfInst) {
    $("#instruction-memory-assembly").html(combineInst(arrayOfInst));
}

function combineInst(instArray) {
    var i;
    var combinedInst = new Array();
    for (i = 0; i < instArray.length; i++) {
        combinedInst.push(instArray[i]);
        if (i != instArray.length - 1) {
            if (navigator.userAgent.toLowerCase().indexOf('firefox') > -1) {
                combinedInst.push("<br>");
            } else {
                combinedInst.push("\n");
            }
        }
    }
    return combinedInst;
}
